import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '../navigation/MainNavigator';
import {
  getAllEmployees,
  getActiveSessions,
  getAnalyticsData,
  getEmployeeRealTimeStatus,
  deleteEmployee,
  Employee,
  Session,
  subscribeToSessions,
  subscribeToActivityLogs,
  subscribeToAppUsage,
  subscribeToWebActivity,
} from '../utils/supabaseClient';

type DashboardNavigationProp = StackNavigationProp<RootStackParamList>;

interface AnalyticsData {
  period: string;
  summary: {
    totalEmployees: number;
    onlineEmployees: number;
    onlineRate: number;
    totalActivities: number;
    totalAppTime: number;
    totalWebTime: number;
  };
  trends: {
    activityByHour: number[];
    topApps: Array<{ app: string; duration: number }>;
    topWebsites: Array<{ domain: string; duration: number }>;
  };
  realtime: {
    lastUpdated: string;
    activeSessions: number;
  };
}

const DashboardScreen: React.FC = () => {
  const { employee, signOut } = useAuth();
  const navigation = useNavigation<DashboardNavigationProp>();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [activeSessions, setActiveSessions] = useState<Session[]>([]);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<string | null>(null);
  const [employeeStatuses, setEmployeeStatuses] = useState<Record<string, any>>({});
  
  // Use refs to track subscriptions and intervals
  const subscriptionsRef = useRef<any[]>([]);
  const statusPollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (employee?.organization_id) {
      loadData();
      setupRealtimeSubscriptions();
      setupStatusPolling();
    }

    // Cleanup function
    return () => {
      cleanupSubscriptions();
      cleanupStatusPolling();
    };
  }, [employee?.organization_id]);

  useEffect(() => {
    if (employee?.organization_id) {
      loadAnalyticsData();
    }
  }, [employee?.organization_id]);

  const cleanupSubscriptions = () => {
    if (subscriptionsRef.current.length > 0) {
      subscriptionsRef.current.forEach(sub => {
        if (sub && typeof sub.unsubscribe === 'function') {
          sub.unsubscribe();
        }
      });
      subscriptionsRef.current = [];
    }
  };

  const cleanupStatusPolling = () => {
    if (statusPollingIntervalRef.current) {
      clearInterval(statusPollingIntervalRef.current);
      statusPollingIntervalRef.current = null;
    }
  };

  const setupRealtimeSubscriptions = () => {
    if (!employee?.organization_id) {
      console.log('❌ No organization_id for real-time subscriptions');
      return;
    }
    
    console.log('🔄 Setting up real-time subscriptions for org:', employee.organization_id);
    
    // Clean up existing subscriptions first
    cleanupSubscriptions();
    
    try {
      const subscriptions = [
        subscribeToSessions((payload) => {
          console.log('🔄 Session update received:', payload);
          console.log('🔄 Reloading data due to session update...');
          loadData();
        }, employee.organization_id),
        subscribeToActivityLogs((payload) => {
          console.log('🔄 Activity update received:', payload);
          console.log('🔄 Reloading analytics due to activity update...');
          loadAnalyticsData();
        }, employee.organization_id),
        subscribeToAppUsage((payload) => {
          console.log('🔄 App usage update received:', payload);
          console.log('🔄 Reloading analytics due to app usage update...');
          loadAnalyticsData();
        }, employee.organization_id),
        subscribeToWebActivity((payload) => {
          console.log('🔄 Web activity update received:', payload);
          console.log('🔄 Reloading analytics due to web activity update...');
          loadAnalyticsData();
        }, employee.organization_id),
      ];

      console.log('🔄 Created subscriptions:', subscriptions.length);
      subscriptionsRef.current = subscriptions;
      console.log('✅ Real-time subscriptions set up successfully');
    } catch (error) {
      console.error('❌ Error setting up real-time subscriptions:', error);
    }
  };

  const setupStatusPolling = () => {
    if (!employee?.organization_id) return;

    // Clean up existing polling
    cleanupStatusPolling();

    const pollStatuses = async () => {
      if (employees.length === 0) return;
      
      const statuses: Record<string, any> = {};
      for (const emp of employees) {
        try {
          const status = await getEmployeeRealTimeStatus(emp.employee_id, employee.organization_id);
          statuses[emp.id] = status;
        } catch (error) {
          console.error(`Error polling status for ${emp.employee_id}:`, error);
        }
      }
      setEmployeeStatuses(statuses);
    };

    // Poll every 10 seconds for more responsive status updates
    statusPollingIntervalRef.current = setInterval(pollStatuses, 10000) as any;
    pollStatuses(); // Initial poll
  };

  const loadData = async () => {
    console.log('🔄 === LOAD DATA STARTED ===');
    console.log('Employee:', employee);
    console.log('Organization ID:', employee?.organization_id);
    
    if (!employee?.organization_id) {
      console.log('❌ No organization_id available for loadData');
      return;
    }
    
    console.log('🔄 Loading dashboard data for organization:', employee.organization_id);
    
    try {
      console.log('🔄 Calling getAllEmployees...');
      const employeesData = await getAllEmployees(employee.organization_id);
      console.log('✅ Employees data loaded:', employeesData.length, 'employees');
      console.log('Employees:', employeesData.map(emp => ({ id: emp.id, name: emp.name, employee_id: emp.employee_id })));
      
      console.log('🔄 Calling getActiveSessions...');
      const sessionsData = await getActiveSessions(employee.organization_id);
      console.log('✅ Sessions data loaded:', sessionsData.length, 'sessions');
      console.log('Sessions:', sessionsData.map(session => ({ 
        employee_id: session.employee_id, 
        login_time: session.login_time,
        is_active: session.is_active 
      })));
      
      setEmployees(employeesData);
      setActiveSessions(sessionsData);
      setLastUpdateTime(new Date().toLocaleTimeString());
      setLoading(false);
      
      console.log('✅ === LOAD DATA COMPLETED ===');
      console.log('Final employees count:', employeesData.length);
      console.log('Final sessions count:', sessionsData.length);
      
      // Load analytics data after main data is loaded
      console.log('🔄 Loading analytics data...');
      await loadAnalyticsData();
      setIsRealtimeActive(true);
      
      // Clean up any stale sessions after initial load
      console.log('🧹 Running initial stale session cleanup...');
      await cleanupStaleSessions();
      
    } catch (error) {
      console.error('❌ Error loading dashboard data:', error);
      setLoading(false);
    }
  };

  const loadAnalyticsData = async () => {
    try {
      console.log('🔄 Loading analytics data for current user');
      const data = await getAnalyticsData(employee?.organization_id || '', 'week', employee?.id);
      console.log('📊 Analytics data received:', data);
      
      if (data) {
        console.log('📈 Summary:', data.summary);
        console.log('📊 Trends:', data.trends);
        console.log('🔄 Realtime:', data.realtime);
        setAnalyticsData(data);
      } else {
        console.log('❌ No analytics data received');
        setAnalyticsData(null);
      }
    } catch (error) {
      console.error('❌ Error loading analytics data:', error);
      setAnalyticsData(null);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    console.log('🔄 Manual refresh triggered');
    await loadData();
    setRefreshing(false);
  };

  const cleanupStaleSessions = async () => {
    console.log('🧹 Cleaning up stale sessions...');
    try {
      // Just refresh the current data without calling loadData again
      const sessionsData = await getActiveSessions(employee?.organization_id || '');
      setActiveSessions(sessionsData);
      console.log('✅ Stale sessions cleanup completed');
    } catch (error) {
      console.error('❌ Error cleaning up stale sessions:', error);
    }
  };

  const hasStaleSessions = () => {
    const now = new Date();
    return activeSessions.some(session => {
      const loginTime = new Date(session.login_time);
      const sessionAge = Math.floor((now.getTime() - loginTime.getTime()) / 1000 / 60);
      return sessionAge > 30;
    });
  };

  const getSessionStatusText = () => {
    const now = new Date();
    const staleSessions = activeSessions.filter(session => {
      const loginTime = new Date(session.login_time);
      const sessionAge = Math.floor((now.getTime() - loginTime.getTime()) / 1000 / 60);
      return sessionAge > 30;
    });
    
    if (staleSessions.length > 0) {
      return `${activeSessions.length} (${staleSessions.length} stale)`;
    }
    return activeSessions.length.toString();
  };

  const handleLogout = async () => {
    Alert.alert(
      'Confirm Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            try {
              await signOut();
              // Navigation will be handled by the auth context
            } catch (error) {
              console.error('Logout error:', error);
              Alert.alert('Error', 'Failed to logout. Please try again.');
            }
          },
        },
      ]
    );
  };

  const handleDeleteEmployee = async (employee: Employee) => {
    Alert.alert(
      'Delete Employee',
      `Are you sure you want to delete ${employee.name} (${employee.employee_id})?\n\nThis action will permanently remove:\n• All their activity data\n• App usage history\n• Web browsing history\n• Session records\n• Employee account\n\nThis action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              setLoading(true);
              const result = await deleteEmployee(employee.employee_id, employee.organization_id);
              
              if (result.success) {
                Alert.alert(
                  'Success',
                  `${employee.name} has been successfully deleted from the system.`,
                  [{ text: 'OK' }]
                );
                // Reload the employee list
                loadData();
              } else {
                Alert.alert('Error', `Failed to delete employee: ${result.error}`);
              }
            } catch (error) {
              console.error('Delete employee error:', error);
              Alert.alert('Error', 'An unexpected error occurred while deleting the employee.');
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  };

  const getEmployeeStatus = (employeeId: string) => {
    const realTimeStatus = employeeStatuses[employeeId];
    
    // Use real-time status if available and recent
    if (realTimeStatus?.isOnline) {
      return 'Online';
    }
    
    // Fallback to session data, but only if it's recent
    const session = activeSessions.find(s => s.employee_id === employeeId);
    if (session) {
      const loginTime = new Date(session.login_time);
      const now = new Date();
      const sessionAge = Math.floor((now.getTime() - loginTime.getTime()) / 1000 / 60); // minutes
      
      // Only show online if session is less than 30 minutes old
      if (sessionAge <= 30) {
        return 'Online';
      } else {
        console.log(`⚠️ Session for ${employeeId} is ${sessionAge} minutes old, showing as offline`);
        return 'Offline';
      }
    }
    
    return 'Offline';
  };

  const getStatusColor = (status: string) => {
    return status === 'Online' ? '#059669' : '#dc2626';
  };

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const formatDuration = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const formatAppTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const getProductivityScore = () => {
    if (!analyticsData) return 0;
    const totalTime = analyticsData.summary.totalAppTime + analyticsData.summary.totalWebTime;
    if (totalTime === 0) return 0;
    
    // Calculate productivity based on productive apps vs total time
    const productiveApps = ['code', 'visual studio', 'intellij', 'eclipse', 'atom', 'sublime', 'figma', 'sketch', 'adobe', 'office', 'excel', 'word', 'powerpoint'];
    const productiveTime = analyticsData.trends.topApps
      .filter(app => productiveApps.some(prod => app.app.toLowerCase().includes(prod)))
      .reduce((sum, app) => sum + app.duration, 0);
    
    return Math.round((productiveTime / totalTime) * 100);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1e3a8a" />
        <Text style={styles.loadingText}>Loading dashboard...</Text>
      </View>
    );
  }

  if (!employee) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>No employee data found</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.welcomeText}>
          Welcome, {employee?.name || 'User'}
        </Text>
        <Text style={styles.roleText}>
          {employee?.role === 'manager' ? 'Manager Dashboard' : 'Employee Dashboard'}
        </Text>
        <View style={styles.onlineIndicator}>
          <View style={[styles.statusDot, { backgroundColor: isRealtimeActive ? '#059669' : '#dc2626' }]} />
          <Text style={styles.onlineText}>
            {isRealtimeActive ? 'Live Data' : 'Offline'}
          </Text>
          {hasStaleSessions() && (
            <View style={styles.staleWarning}>
              <Text style={styles.staleWarningText}>⚠️ Stale Data</Text>
            </View>
          )}
        </View>
      </View>

      {/* User Stats */}
      <View style={styles.statsContainer}>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{getSessionStatusText()}</Text>
          <Text style={styles.statLabel}>Active Sessions</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>
            {analyticsData?.summary?.totalActivities || 0}
          </Text>
          <Text style={styles.statLabel}>My Activities</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>
            {formatAppTime(analyticsData?.summary?.totalAppTime || 0)}
          </Text>
          <Text style={styles.statLabel}>App Time</Text>
        </View>
      </View>

      {/* My Top Apps */}
      {analyticsData?.trends?.topApps && analyticsData.trends.topApps.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>My Most Used Apps</Text>
          {analyticsData.trends.topApps.map((app, index) => (
            <View key={index} style={styles.appItem}>
              <Text style={styles.appName}>{app.app}</Text>
              <Text style={styles.appDuration}>{formatAppTime(app.duration)}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Quick Actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate('Report', {})}
          >
            <Text style={styles.actionButtonText}>My Report</Text>
          </TouchableOpacity>
          {employee?.role === 'admin' && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => navigation.navigate('EmployeeRegistration', undefined)}
            >
              <Text style={styles.actionButtonText}>Register</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate('Settings', undefined)}
          >
            <Text style={styles.actionButtonText}>Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.actionButton} 
            onPress={onRefresh}
            disabled={refreshing}
          >
            <Text style={styles.actionButtonText}>
              {refreshing ? '🔄' : '🔄\nRefresh'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.actionButton} 
            onPress={cleanupStaleSessions}
          >
            <Text style={styles.actionButtonText}>🧹{'\n'}Clean Stale</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Team Overview (only for managers/admins) */}
      {(employee?.role === 'manager' || employee?.role === 'admin') && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Team Overview</Text>
          {employees.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No employees found in your organization</Text>
            </View>
          ) : (
            employees.map((emp) => {
              const status = getEmployeeStatus(emp.id);
              const session = activeSessions.find(s => s.employee_id === emp.id);
              const realTimeStatus = employeeStatuses[emp.id];
              
              return (
                <View key={emp.id} style={styles.employeeCard}>
                  <TouchableOpacity
                    style={styles.employeeCardContent}
                    onPress={() => navigation.navigate('ProjectSelection', { employeeId: emp.employee_id })}
                  >
                    <View style={styles.employeeInfo}>
                      <Text style={styles.employeeName}>{emp.name}</Text>
                      <Text style={styles.employeeDepartment}>{emp.department}</Text>
                      <Text style={styles.employeeRole}>{emp.role}</Text>
                    </View>
                    <View style={styles.employeeStatus}>
                      <View style={[styles.statusDot, { backgroundColor: getStatusColor(status) }]} />
                      <Text style={[styles.statusText, { color: getStatusColor(status) }]}>
                        {status}
                      </Text>
                      {realTimeStatus?.isOnline && realTimeStatus.sessionDuration > 0 && (
                        <Text style={styles.loginTime}>
                          {formatDuration(realTimeStatus.sessionDuration)}
                        </Text>
                      )}
                      {session && !realTimeStatus?.isOnline && (
                        <Text style={styles.loginTime}>
                          Since {formatTime(session.login_time)}
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                  
                  {/* Delete button - only show for managers/admins and not for self */}
                  {(employee?.role === 'manager' || employee?.role === 'admin') && emp.id !== employee?.id && (
                    <TouchableOpacity
                      style={styles.deleteButton}
                      onPress={() => handleDeleteEmployee(emp)}
                    >
                      <Text style={styles.deleteButtonText}>🗑️</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })
          )}
        </View>
      )}

      {/* Logout Button */}
      <View style={styles.logoutSection}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutButtonText}>Logout</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  loadingText: {
    fontSize: 14,
    color: '#6b7280',
  },
  header: {
    backgroundColor: '#ffffff',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  welcomeText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1f2937',
    marginBottom: 2,
  },
  roleText: {
    fontSize: 12,
    color: '#6b7280',
  },
  onlineIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  onlineText: {
    fontSize: 12,
    color: '#6b7280',
  },
  statsContainer: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  statNumber: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1e3a8a',
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 10,
    color: '#6b7280',
    textAlign: 'center',
  },
  section: {
    backgroundColor: '#ffffff',
    margin: 12,
    marginTop: 0,
    borderRadius: 8,
    padding: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    backgroundColor: '#1e3a8a',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },
  actionButtonText: {
    color: '#ffffff',
    fontSize: 8,
    fontWeight: '600',
    textAlign: 'center',
    flexShrink: 1,
    lineHeight: 16,
  },
  employeeCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#ffffff',
    borderRadius: 6,
    marginVertical: 2,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  employeeCardContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flex: 1,
  },
  employeeInfo: {
    flex: 1,
  },
  employeeName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 1,
  },
  employeeDepartment: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 1,
  },
  employeeRole: {
    fontSize: 10,
    color: '#1e3a8a',
  },
  employeeStatus: {
    alignItems: 'flex-end',
  },
  statusText: {
    fontSize: 10,
    fontWeight: '600',
  },
  loginTime: {
    fontSize: 9,
    color: '#6b7280',
  },
  logoutSection: {
    backgroundColor: '#ffffff',
    margin: 12,
    padding: 12,
    borderRadius: 8,
  },
  logoutButton: {
    backgroundColor: '#dc2626',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  logoutButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 14,
    color: '#6b7280',
  },
  appItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  appName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
  },
  appDuration: {
    fontSize: 10,
    color: '#6b7280',
  },
  staleWarning: {
    backgroundColor: '#dc2626',
    padding: 4,
    borderRadius: 4,
    marginLeft: 8,
  },
  staleWarningText: {
    fontSize: 10,
    color: '#ffffff',
    fontWeight: '600',
  },
  deleteButton: {
    backgroundColor: '#dc2626',
    padding: 8,
    borderRadius: 6,
    marginLeft: 8,
    minWidth: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});

export default DashboardScreen; 