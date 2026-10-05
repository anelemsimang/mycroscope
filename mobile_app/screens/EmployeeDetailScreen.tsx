import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { useAuth } from '../context/AuthContext';
import { RootStackParamList } from '../navigation/MainNavigator';
import {
  getEmployeeByEmployeeId,
  getActivityLogs,
  getAppUsage,
  getWebActivity,
  Employee,
  ActivityLog,
  AppUsage,
  WebActivity,
  getDailySummaries,
  getDailySummaryByDate,
  getAvailableDates,
  getEmployeeRealTimeStatus,
  subscribeToAppUsage,
  subscribeToWebActivity,
  subscribeToActivityLogs,
  getEmployeeCurrentActivity,
  cleanupOldSessions,
  supabase,
  getEmployeeCurrentProject,
} from '../utils/supabaseClient';

type EmployeeDetailScreenNavigationProp = StackNavigationProp<RootStackParamList, 'EmployeeDetail'>;

interface AppSummary {
  app_name: string;
  total_time: number;
  session_count: number;
  last_used: string;
  avg_session_duration: number;
  most_common_title: string;
  title_frequency: number;
  idle_time: number;
  active_time: number;
  is_active: boolean;
  end_time?: string;
}

interface WebSummary {
  domain: string;
  total_time: number;
  visit_count: number;
  last_visited: string;
  most_common_title: string;
  title_frequency: number;
}

interface ActivitySummary {
  activity_type: string;
  frequency: number;
  last_occurrence: string;
  total_duration: number;
  avg_duration: number;
}

interface DailySummary {
  id: string;
  employee_id: string;
  organization_id: string;
  date: string;
  app_summary: any[];
  web_summary: any[];
  activity_summary: any[];
  total_active_time: number;
  total_sessions: number;
  most_used_app?: string;
  most_visited_domain?: string;
  created_at: string;
  updated_at: string;
}

const EmployeeDetailScreen: React.FC = () => {
  const route = useRoute();
  const navigation = useNavigation<EmployeeDetailScreenNavigationProp>();
  const { employeeId, projectFilter } = route.params as { employeeId: string; projectFilter?: string };
  const { employee } = useAuth();
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [appUsage, setAppUsage] = useState<AppUsage[]>([]);
  const [webActivity, setWebActivity] = useState<WebActivity[]>([]);
  const [dailySummaries, setDailySummaries] = useState<DailySummary[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [isOnline, setIsOnline] = useState(false);
  const [currentActivity, setCurrentActivity] = useState<any>(null);
  const [lastActivityTime, setLastActivityTime] = useState<string | null>(null);
  const [employeeStatus, setEmployeeStatus] = useState<any>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [filteredAppUsage, setFilteredAppUsage] = useState<AppUsage[]>([]);
  const [filteredWebActivity, setFilteredWebActivity] = useState<WebActivity[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(projectFilter || null);
  const [isCurrentProjectActive, setIsCurrentProjectActive] = useState<boolean>(false);

  // Real-time subscriptions
  const appUsageSubscriptionRef = useRef<any>(null);
  const webActivitySubscriptionRef = useRef<any>(null);
  const activityLogsSubscriptionRef = useRef<any>(null);
  const statusPollingRef = useRef<any>(null);

  useEffect(() => {
    if (employeeId && employee?.organization_id) {
      loadEmployeeData();
    }
  }, [employeeId, employee]);

  // Load daily summaries when history tab is selected
  useEffect(() => {
    if (activeTab === 'history' && selectedEmployee?.employee_id) {
      loadDailySummaries();
    }
  }, [activeTab, selectedEmployee?.employee_id]);

  // Setup real-time tracking
  useEffect(() => {
    if (selectedEmployee?.id && employee?.organization_id) {
      setupRealTimeTracking();
    }
    
    return () => {
      cleanupRealTimeTracking();
    };
  }, [selectedEmployee?.id, employee?.organization_id]);

  const setupRealTimeTracking = () => {
    if (!selectedEmployee?.id || !employee?.organization_id) return;
    
    console.log('🔄 Setting up real-time tracking for employee:', selectedEmployee.employee_id, 'UUID:', selectedEmployee.id);
    
    // Poll for current activity and status every 10 seconds
    statusPollingRef.current = setInterval(async () => {
      try {
        // Get real-time status for accurate online/offline status
        const realTimeStatus = await getEmployeeRealTimeStatus(selectedEmployee.id, employee.organization_id);
        setIsOnline(realTimeStatus.isOnline);
        setEmployeeStatus(realTimeStatus);
        
        // Get current activity for display purposes only
        const currentActivityData = await getEmployeeCurrentActivity(selectedEmployee.id, employee.organization_id);
        
        if (currentActivityData) {
          setCurrentActivity({
            ...currentActivityData,
            timestamp: currentActivityData.timestamp || new Date().toISOString()
          });
        } else {
          setCurrentActivity(null);
        }
        
      } catch (error) {
        console.error('❌ Error fetching current activity:', error);
      }
    }, 10000); // Poll every 10 seconds
  };

  const updateCurrentActivity = (activity: any, type: 'app' | 'web' | 'activity') => {
    setCurrentActivity({
      ...activity,
      type,
      timestamp: new Date().toISOString()
    });
  };

  const cleanupRealTimeTracking = () => {
    console.log('🧹 Cleaning up real-time tracking');
    
    if (statusPollingRef.current) {
      clearInterval(statusPollingRef.current);
      statusPollingRef.current = null;
    }
    
    if (appUsageSubscriptionRef.current) {
      appUsageSubscriptionRef.current.unsubscribe();
      appUsageSubscriptionRef.current = null;
    }
    
    if (webActivitySubscriptionRef.current) {
      webActivitySubscriptionRef.current.unsubscribe();
      webActivitySubscriptionRef.current = null;
    }
    
    if (activityLogsSubscriptionRef.current) {
      activityLogsSubscriptionRef.current.unsubscribe();
      activityLogsSubscriptionRef.current = null;
    }
  };

  const loadEmployeeData = async () => {
    if (!employeeId || !employee?.organization_id) return;
    
    try {
      setLoading(true);
      
      // First get the employee data to get the UUID
      const employeeData = await getEmployeeByEmployeeId(employeeId, employee.organization_id);
      
      if (!employeeData) {
        console.error('Employee not found:', employeeId);
        return;
      }
      
      setSelectedEmployee(employeeData);
      
      // Use the UUID (employeeData.id) for database queries since that's what the database expects
      const [logsData, appsData, webData] = await Promise.all([
        getActivityLogs(employee.organization_id, employeeData.id),
        getAppUsage(employee.organization_id, employeeData.id),
        getWebActivity(employee.organization_id, employeeData.id),
      ]);

      // Filter data by project if a project is selected
      let filteredLogsData = logsData;
      let filteredAppsData = appsData;
      let filteredWebData = webData;

      if (selectedProject) {
        // Filter activity logs by project
        if (selectedProject === 'No Project') {
          filteredLogsData = logsData.filter(log =>
            !log.metadata?.current_project || log.metadata?.current_project === null || log.metadata?.current_project === ''
          );
        } else {
          filteredLogsData = logsData.filter(log =>
            log.metadata?.current_project === selectedProject
          );
        }

        // Filter app usage by project field
        if (selectedProject === 'No Project') {
          filteredAppsData = appsData.filter(app =>
            !app.current_project || app.current_project === null || app.current_project === ''
          );
        } else {
          filteredAppsData = appsData.filter(app =>
            app.current_project === selectedProject
          );
        }

        // Filter web activity by project field
        if (selectedProject === 'No Project') {
          filteredWebData = webData.filter(web =>
            !web.current_project || web.current_project === null || web.current_project === ''
          );
        } else {
          filteredWebData = webData.filter(web =>
            web.current_project === selectedProject
          );
        }
      }

      setActivityLogs(filteredLogsData);
      setAppUsage(filteredAppsData);
      setWebActivity(filteredWebData);

      // Fetch and set current project status
      if (selectedProject) {
        const currentProject = await getEmployeeCurrentProject(employeeData.id, employee.organization_id);
        setIsCurrentProjectActive(currentProject === selectedProject);
      } else {
        setIsCurrentProjectActive(false);
      }

      setLoading(false);
    } catch (error) {
      console.error('❌ Error loading employee data:', error);
      Alert.alert('Error', 'Failed to load employee data');
      setLoading(false);
    }
  };

  const loadDailySummaries = async () => {
    try {
      console.log('📅 Loading daily summaries for employee:', selectedEmployee?.employee_id, 'UUID:', selectedEmployee?.id);
      const summaries = await getDailySummaries(selectedEmployee?.id || '');
      setDailySummaries(summaries);
      setAvailableDates(summaries.map(summary => summary.date));
      console.log('✅ Daily summaries loaded:', summaries.length);
    } catch (error) {
      console.error('❌ Error loading daily summaries:', error);
    }
  };

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const getStatusColor = (isActive: boolean) => {
    return isActive ? '#059669' : '#dc2626';
  };

  const getRoleColor = (role: string) => {
    switch (role) {
      case 'admin':
        return '#dc2626';
      case 'manager':
        return '#f59e0b';
      default:
        return '#1e3a8a';
    }
  };

  // Data processing functions
  const processAppUsage = (apps: AppUsage[]): AppSummary[] => {
    const grouped = apps.reduce((acc, app) => {
      if (!acc[app.app_name]) {
        acc[app.app_name] = {
          app_name: app.app_name,
          total_time: 0,
          session_count: 0,
          last_used: app.start_time,
          titles: {} as Record<string, number>,
          sessions: [] as AppUsage[],
          idle_time: 0,
          active_time: 0,
          is_active: false,
          end_time: undefined
        };
      }
      
      const duration = app.duration_seconds || 0;
      acc[app.app_name].total_time += duration;
      acc[app.app_name].sessions.push(app);
      
      // Calculate active vs idle time (simplified logic - you can enhance this)
      // For now, we'll assume 80% active, 20% idle as a placeholder
      const activeTime = Math.floor(duration * 0.8);
      const idleTime = duration - activeTime;
      acc[app.app_name].active_time += activeTime;
      acc[app.app_name].idle_time += idleTime;
      
      if (app.start_time > acc[app.app_name].last_used) {
        acc[app.app_name].last_used = app.start_time;
      }
      
      if (app.window_title) {
        acc[app.app_name].titles[app.window_title] = (acc[app.app_name].titles[app.window_title] || 0) + 1;
      }
      
      // Track if any session is currently active (no end_time)
      if (!app.end_time) {
        acc[app.app_name].is_active = true;
      }
      
      return acc;
    }, {} as Record<string, any>);

    return Object.values(grouped).map(app => {
      // Calculate actual session count - only count completed sessions or active sessions
      let sessionCount = 0;
      
      // Count completed sessions (have end_time)
      const completedSessions = app.sessions.filter((session: AppUsage) => session.end_time);
      sessionCount += completedSessions.length;
      
      // If there are active sessions (no end_time), count as 1 additional session
      const activeSessions = app.sessions.filter((session: AppUsage) => !session.end_time);
      if (activeSessions.length > 0) {
        sessionCount += 1; // Only count as 1 active session, not multiple records
      }
      
      const mostCommonTitle = Object.entries(app.titles)
        .sort(([,a], [,b]) => (b as number) - (a as number))[0];
      
      return {
        app_name: app.app_name,
        total_time: app.total_time,
        session_count: sessionCount,
        last_used: app.last_used,
        avg_session_duration: app.total_time / Math.max(sessionCount, 1),
        most_common_title: mostCommonTitle ? mostCommonTitle[0] : 'N/A',
        title_frequency: mostCommonTitle ? mostCommonTitle[1] as number : 0,
        idle_time: app.idle_time,
        active_time: app.active_time,
        is_active: app.is_active,
        end_time: app.end_time
      };
    }).sort((a, b) => b.total_time - a.total_time);
  };

  const processWebActivity = (websites: WebActivity[]): WebSummary[] => {
    const grouped = websites.reduce((acc, web) => {
      let domain = 'Unknown';
      
      // First try to use the domain field if it exists
      if (web.domain) {
        domain = web.domain;
      } else {
        // Try to extract domain from URL
        try {
          // Check if it's already a domain (no protocol)
          if (web.url && !web.url.includes('://') && !web.url.startsWith('http')) {
            // It's already a domain
            domain = web.url;
          } else {
            // It's a full URL, parse it
            const url = new URL(web.url);
            domain = url.hostname;
          }
        } catch (error) {
          console.log('Invalid URL:', web.url);
          // Try to extract domain manually
          if (web.url) {
            // Remove protocol if present
            let cleanUrl = web.url;
            if (cleanUrl.includes('://')) {
              cleanUrl = cleanUrl.split('://')[1];
            }
            // Get the first part (domain)
            domain = cleanUrl.split('/')[0];
            // Remove www. prefix
            if (domain.startsWith('www.')) {
              domain = domain.substring(4);
            }
          } else {
            domain = 'Unknown Domain';
          }
        }
      }
      
      // Clean up domain
      if (domain.startsWith('www.')) {
        domain = domain.substring(4);
      }
      
      if (!acc[domain]) {
        acc[domain] = {
          domain,
          total_time: 0,
          visit_count: 0,
          last_visited: web.start_time,
          titles: {} as Record<string, number>,
          visits: [] as WebActivity[]
        };
      }
      
      acc[domain].total_time += web.duration_seconds || 0;
      acc[domain].visits.push(web);
      
      if (web.start_time > acc[domain].last_visited) {
        acc[domain].last_visited = web.start_time;
      }
      
      if (web.title) {
        acc[domain].titles[web.title] = (acc[domain].titles[web.title] || 0) + 1;
      }
      
      return acc;
    }, {} as Record<string, any>);

    return Object.values(grouped).map((group: any) => {
      // Calculate actual visit count - group visits by time proximity
      let visitCount = 0;
      const visits = group.visits.sort((a: WebActivity, b: WebActivity) => 
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
      );
      
      if (visits.length > 0) {
        // Count the first visit
        visitCount = 1;
        
        // Count additional visits if they're separated by more than 5 minutes
        for (let i = 1; i < visits.length; i++) {
          const prevVisit = new Date(visits[i-1].start_time);
          const currentVisit = new Date(visits[i].start_time);
          const timeDiff = (currentVisit.getTime() - prevVisit.getTime()) / (1000 * 60); // minutes
          
          if (timeDiff > 5) { // If more than 5 minutes apart, count as new visit
            visitCount++;
          }
        }
      }
      
      const mostCommonTitle = Object.entries(group.titles)
        .sort(([,a]: any, [,b]: any) => b - a)[0] || ['N/A', 0];
      
      return {
        domain: group.domain,
        total_time: group.total_time,
        visit_count: visitCount,
        last_visited: group.last_visited,
        most_common_title: mostCommonTitle[0],
        title_frequency: mostCommonTitle[1] as number
      };
    }).sort((a, b) => b.total_time - a.total_time);
  };

  const processActivityLogs = (logs: ActivityLog[]): ActivitySummary[] => {
    const grouped = logs.reduce((acc, log) => {
      if (!acc[log.activity_type]) {
        acc[log.activity_type] = {
          activity_type: log.activity_type,
          frequency: 0,
          last_occurrence: log.timestamp,
          total_duration: 0,
          occurrences: [] as ActivityLog[]
        };
      }
      
      acc[log.activity_type].frequency += 1;
      acc[log.activity_type].occurrences.push(log);
      acc[log.activity_type].total_duration += (log as any).duration_seconds || 0;
      
      if (log.timestamp > acc[log.activity_type].last_occurrence) {
        acc[log.activity_type].last_occurrence = log.timestamp;
      }
      
      return acc;
    }, {} as Record<string, any>);

    return Object.values(grouped).map((group: any) => ({
      activity_type: group.activity_type,
      frequency: group.frequency,
      last_occurrence: group.last_occurrence,
      total_duration: group.total_duration,
      avg_duration: group.total_duration / group.frequency
    })).sort((a, b) => b.frequency - a.frequency);
  };

  const getCurrentDayAnalytics = () => {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();
    
    // Filter data for today only
    const todayActivityLogs = activityLogs.filter(log => {
      const logDate = new Date(log.timestamp);
      return logDate >= new Date(startOfDay) && logDate <= new Date(endOfDay);
    });
    
    const todayAppUsage = appUsage.filter(app => {
      const appDate = new Date(app.start_time);
      return appDate >= new Date(startOfDay) && appDate <= new Date(endOfDay);
    });
    
    const todayWebActivity = webActivity.filter(web => {
      const webDate = new Date(web.start_time);
      return webDate >= new Date(startOfDay) && webDate <= new Date(endOfDay);
    });
    
    return {
      totalActivities: todayActivityLogs.length,
      appHours: Math.round(todayAppUsage.reduce((sum, app) => sum + (app.duration_seconds || 0), 0) / 3600 * 10) / 10,
      webHours: Math.round(todayWebActivity.reduce((sum, web) => sum + (web.duration_seconds || 0), 0) / 3600 * 10) / 10,
      appsUsed: new Set(todayAppUsage.map(app => app.app_name)).size,
      isOnline: isOnline,
      currentActivity: currentActivity
    };
  };

  const handleDateSelect = (date: string) => {
    setSelectedDate(date);
    
    // Filter data for the selected date
    const startOfDay = new Date(date);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    const filteredApps = appUsage.filter(app => {
      const appDate = new Date(app.start_time);
      return appDate >= startOfDay && appDate <= endOfDay;
    });
    
    const filteredWeb = webActivity.filter(web => {
      const webDate = new Date(web.start_time);
      return webDate >= startOfDay && webDate <= endOfDay;
    });
    
    setFilteredAppUsage(filteredApps);
    setFilteredWebActivity(filteredWeb);
  };

  const clearDateFilter = () => {
    setSelectedDate(null);
    
    // Reset to today's data instead of all data
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();
    
    const todayAppUsage = appUsage.filter(app => {
      const appDate = new Date(app.start_time);
      return appDate >= new Date(startOfDay) && appDate <= new Date(endOfDay);
    });
    
    const todayWebActivity = webActivity.filter(web => {
      const webDate = new Date(web.start_time);
      return webDate >= new Date(startOfDay) && webDate <= new Date(endOfDay);
    });
    
    setFilteredAppUsage(todayAppUsage);
    setFilteredWebActivity(todayWebActivity);
  };

  const deleteTodaysData = async () => {
    if (!selectedEmployee?.id || !employee?.organization_id) return;
    
    Alert.alert(
      'Delete Today\'s Data',
      'This will permanently delete all activity data for today. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const today = new Date();
              const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
              const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();
              
              // Delete app usage for today
              const { error: appError } = await supabase
                .from('app_usage')
                .delete()
                .eq('employee_id', selectedEmployee.id)
                .gte('start_time', startOfDay)
                .lte('start_time', endOfDay);
              
              // Delete web activity for today
              const { error: webError } = await supabase
                .from('web_activity')
                .delete()
                .eq('employee_id', selectedEmployee.id)
                .gte('start_time', startOfDay)
                .lte('start_time', endOfDay);
              
              // Delete activity logs for today
              const { error: logError } = await supabase
                .from('activity_logs')
                .delete()
                .eq('employee_id', selectedEmployee.id)
                .gte('timestamp', startOfDay)
                .lte('timestamp', endOfDay);
              
              if (appError || webError || logError) {
                throw new Error('Failed to delete data');
              }
              
              Alert.alert('Success', 'Today\'s data has been deleted successfully');
              loadEmployeeData(); // Refresh data
            } catch (error) {
              console.error('Error deleting today\'s data:', error);
              Alert.alert('Error', 'Failed to delete today\'s data');
            }
          }
        }
      ]
    );
  };

  const deleteAllHistory = async () => {
    if (!selectedEmployee?.id || !employee?.organization_id) return;
    
    Alert.alert(
      'Delete All History',
      'This will permanently delete ALL historical activity data for this employee (excluding today\'s data). This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete History',
          style: 'destructive',
          onPress: async () => {
            try {
              const today = new Date();
              const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
              
              // Delete all app usage EXCEPT today's
              const { error: appError } = await supabase
                .from('app_usage')
                .delete()
                .eq('employee_id', selectedEmployee.id)
                .lt('start_time', startOfDay);
              
              // Delete all web activity EXCEPT today's
              const { error: webError } = await supabase
                .from('web_activity')
                .delete()
                .eq('employee_id', selectedEmployee.id)
                .lt('start_time', startOfDay);
              
              // Delete all activity logs EXCEPT today's
              const { error: logError } = await supabase
                .from('activity_logs')
                .delete()
                .eq('employee_id', selectedEmployee.id)
                .lt('timestamp', startOfDay);
              
              // Delete all daily summaries EXCEPT today's
              const { error: summaryError } = await supabase
                .from('daily_summaries')
                .delete()
                .eq('employee_id', selectedEmployee.id)
                .lt('date', today.toISOString().split('T')[0]);
              
              if (appError || webError || logError || summaryError) {
                throw new Error('Failed to delete history');
              }
              
              Alert.alert('Success', 'All historical data has been deleted successfully');
              loadEmployeeData(); // Refresh data
            } catch (error) {
              console.error('Error deleting all history:', error);
              Alert.alert('Error', 'Failed to delete historical data');
            }
          }
        }
      ]
    );
  };

  const checkProjectStatus = async () => {
    if (!selectedEmployee?.id || !employee?.organization_id || !selectedProject) return;
    
    try {
      const currentProject = await getEmployeeCurrentProject(selectedEmployee.id, employee.organization_id);
      setIsCurrentProjectActive(currentProject === selectedProject);
      console.log('🎯 Project status check:', selectedProject, 'is active:', currentProject === selectedProject);
    } catch (error) {
      console.error('Error checking project status:', error);
      setIsCurrentProjectActive(false);
    }
  };

  useEffect(() => {
    if (selectedEmployee && selectedProject) {
      checkProjectStatus();
    }
  }, [selectedEmployee, selectedProject]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1e3a8a" />
        <Text style={styles.loadingText}>Loading employee details...</Text>
      </View>
    );
  }

  if (!selectedEmployee) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Employee not found</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Fixed Header */}
      <View style={styles.header}>
        <Text style={styles.name}>{selectedEmployee.name}</Text>
        <View style={styles.badges}>
          <View style={[styles.roleBadge, { backgroundColor: getRoleColor(selectedEmployee.role) }]}>
            <Text style={styles.roleText}>{selectedEmployee.role.toUpperCase()}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: isOnline ? '#059669' : '#dc2626' }]}>
            <Text style={styles.statusText}>{isOnline ? 'ONLINE' : 'OFFLINE'}</Text>
          </View>
          {employeeStatus?.sessionDuration > 0 && (
            <View style={styles.sessionBadge}>
              <Text style={styles.sessionText}>{employeeStatus.sessionDuration}m</Text>
            </View>
          )}
          {selectedProject && (
            <View style={[styles.projectIndicator, { backgroundColor: isCurrentProjectActive ? '#059669' : '#dc2626' }]}>
              <Text style={styles.projectText}>📁 {selectedProject} {isCurrentProjectActive ? 'ACTIVE' : 'INACTIVE'}</Text>
            </View>
          )}
        </View>
        {lastActivityTime && (
          <Text style={styles.lastActivityText}>
            Last activity: {formatTime(lastActivityTime)}
          </Text>
        )}
      </View>

      {/* Fixed Employee Info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Employee Information</Text>
        <View style={styles.infoGrid}>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Employee ID</Text>
            <Text style={styles.infoValue}>{selectedEmployee.employee_id}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Email</Text>
            <Text style={styles.infoValue}>{selectedEmployee.email}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Department</Text>
            <Text style={styles.infoValue}>{selectedEmployee.department}</Text>
          </View>
          {selectedEmployee.position && (
            <View style={styles.infoItem}>
              <Text style={styles.infoLabel}>Position</Text>
              <Text style={styles.infoValue}>{selectedEmployee.position}</Text>
            </View>
          )}
        </View>
        
        {/* Action Buttons */}
        <View style={styles.actionButtonsContainer}>
          <View style={styles.actionButtonRow}>
            <TouchableOpacity 
              style={styles.actionButton} 
              onPress={loadEmployeeData}
            >
              <Text style={styles.actionButtonText}>🔄 Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.actionButton} 
              onPress={async () => {
                try {
                  await cleanupOldSessions(employee?.organization_id);
                  Alert.alert('Success', 'Stale sessions cleaned up successfully');
                  loadEmployeeData(); // Refresh data after cleanup
                } catch (error) {
                  console.error('Error cleaning stale sessions:', error);
                  Alert.alert('Error', 'Failed to clean stale sessions');
                }
              }}
            >
              <Text style={styles.actionButtonText}>🧹 Clean Stale</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.actionButtonRow}>
            <TouchableOpacity 
              style={styles.deleteButton} 
              onPress={deleteTodaysData}
            >
              <Text style={styles.deleteButtonText}>🗑️ Today's Data</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.deleteButtonDanger} 
              onPress={deleteAllHistory}
            >
              <Text style={styles.deleteButtonText}>🗑️ All History</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Fixed Tabs */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'overview' && styles.activeTab]}
          onPress={() => setActiveTab('overview')}
        >
          <Text style={[styles.tabText, activeTab === 'overview' && styles.activeTabText]}>
            Overview
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'activity' && styles.activeTab]}
          onPress={() => setActiveTab('activity')}
        >
          <Text style={[styles.tabText, activeTab === 'activity' && styles.activeTabText]}>
            Activity
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'apps_web' && styles.activeTab]}
          onPress={() => setActiveTab('apps_web')}
        >
          <Text style={[styles.tabText, activeTab === 'apps_web' && styles.activeTabText]}>
            Apps & Web
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'history' && styles.activeTab]}
          onPress={() => setActiveTab('history')}
        >
          <Text style={[styles.tabText, activeTab === 'history' && styles.activeTabText]}>
            History
          </Text>
        </TouchableOpacity>
      </View>

      {/* Scrollable Tab Content - This should take remaining space */}
      <View style={styles.scrollableContainer}>
        <ScrollView 
          style={styles.scrollableContent}
          contentContainerStyle={styles.scrollableContentContainer}
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
          bounces={true}
        >
          {activeTab === 'overview' && (
            <View style={styles.overviewSection}>
              {(() => {
                const analytics = getCurrentDayAnalytics();
                return (
                  <>
                    {/* Live Status */}
                    <View style={styles.liveStatusCard}>
                      <View style={styles.liveStatusHeader}>
                        <Text style={styles.liveStatusTitle}>Live Status</Text>
                        <View style={[styles.statusIndicator, { backgroundColor: analytics.isOnline ? '#059669' : '#dc2626' }]} />
                      </View>
                      <Text style={styles.liveStatusText}>
                        {analytics.isOnline ? 'Currently Online' : 'Currently Offline'}
                      </Text>
                      {currentActivity && (
                        <Text style={styles.currentActivityText}>
                          Current: {currentActivity.type === 'app' ? currentActivity.app_name : 
                                   currentActivity.type === 'web' ? currentActivity.domain : 
                                   currentActivity.activity_type}
                        </Text>
                      )}
                    </View>

                    {/* Today's Stats */}
                    <Text style={styles.sectionTitle}>Today's Activity</Text>
                    <View style={styles.statsGrid}>
                      <View style={styles.statCard}>
                        <Text style={styles.statNumber}>{analytics.totalActivities}</Text>
                        <Text style={styles.statLabel}>Activities</Text>
                      </View>
                      <View style={styles.statCard}>
                        <Text style={styles.statNumber}>{analytics.appHours}h</Text>
                        <Text style={styles.statLabel}>App Time</Text>
                      </View>
                      <View style={styles.statCard}>
                        <Text style={styles.statNumber}>{analytics.webHours}h</Text>
                        <Text style={styles.statLabel}>Web Time</Text>
                      </View>
                      <View style={styles.statCard}>
                        <Text style={styles.statNumber}>{analytics.appsUsed}</Text>
                        <Text style={styles.statLabel}>Apps Used</Text>
                      </View>
                    </View>

                    {/* All Time Stats */}
                    <Text style={styles.sectionTitle}>All Time Summary</Text>
                    <View style={styles.statsGrid}>
                      <View style={styles.statCard}>
                        <Text style={styles.statNumber}>{activityLogs.length}</Text>
                        <Text style={styles.statLabel}>Total Activities</Text>
                      </View>
                      <View style={styles.statCard}>
                        <Text style={styles.statNumber}>
                          {Math.round(appUsage.reduce((sum, app) => sum + (app.duration_seconds || 0), 0) / 3600 * 10) / 10}
                        </Text>
                        <Text style={styles.statLabel}>Total App Hours</Text>
                      </View>
                      <View style={styles.statCard}>
                        <Text style={styles.statNumber}>
                          {Math.round(webActivity.reduce((sum, web) => sum + (web.duration_seconds || 0), 0) / 3600 * 10) / 10}
                        </Text>
                        <Text style={styles.statLabel}>Total Web Hours</Text>
                      </View>
                      <View style={styles.statCard}>
                        <Text style={styles.statNumber}>{new Set(appUsage.map(app => app.app_name)).size}</Text>
                        <Text style={styles.statLabel}>Total Apps</Text>
                      </View>
                    </View>
                  </>
                );
              })()}
            </View>
          )}

          {activeTab === 'activity' && (
            <View style={styles.activitySection}>
              <Text style={styles.sectionTitle}>Current Activity</Text>
              
              {!isOnline ? (
                <View style={styles.offlineCard}>
                  <Text style={styles.offlineText}>Employee is currently offline</Text>
                  <Text style={styles.offlineSubtext}>No live activity to display</Text>
                </View>
              ) : !currentActivity ? (
                <View style={styles.loadingCard}>
                  <ActivityIndicator size="small" color="#1e3a8a" />
                  <Text style={styles.loadingActivityText}>Waiting for activity...</Text>
                </View>
              ) : (
                <View style={styles.currentActivityCard}>
                  <View style={styles.activityHeader}>
                    <Text style={styles.activityType}>
                      {currentActivity.type === 'app' ? '📱' : currentActivity.type === 'web' ? '🌐' : '📊'} 
                      {currentActivity.type.toUpperCase()} ACTIVITY
                    </Text>
                    <Text style={styles.activityTime}>
                      {formatTime(currentActivity.timestamp)}
                    </Text>
                  </View>
                  
                  <View style={styles.activityDetails}>
                    {currentActivity.type === 'app' && (
                      <>
                        <View style={styles.activityRow}>
                          <Text style={styles.activityLabel}>Application:</Text>
                          <Text style={styles.activityValue}>{currentActivity.app_name}</Text>
                        </View>
                        {currentActivity.window_title && (
                          <View style={styles.activityRow}>
                            <Text style={styles.activityLabel}>Window:</Text>
                            <Text style={styles.activityValue} numberOfLines={2}>
                              {currentActivity.window_title}
                            </Text>
                          </View>
                        )}
                        {currentActivity.duration_seconds && (
                          <View style={styles.activityRow}>
                            <Text style={styles.activityLabel}>Duration:</Text>
                            <Text style={styles.activityValue}>
                              {formatDuration(currentActivity.duration_seconds)}
                            </Text>
                          </View>
                        )}
                      </>
                    )}
                    
                    {currentActivity.type === 'web' && (
                      <>
                        <View style={styles.activityRow}>
                          <Text style={styles.activityLabel}>Website:</Text>
                          <Text style={styles.activityValue}>{currentActivity.domain}</Text>
                        </View>
                        {currentActivity.title && (
                          <View style={styles.activityRow}>
                            <Text style={styles.activityLabel}>Page:</Text>
                            <Text style={styles.activityValue} numberOfLines={2}>
                              {currentActivity.title}
                            </Text>
                          </View>
                        )}
                        {currentActivity.duration_seconds && (
                          <View style={styles.activityRow}>
                            <Text style={styles.activityLabel}>Duration:</Text>
                            <Text style={styles.activityValue}>
                              {formatDuration(currentActivity.duration_seconds)}
                            </Text>
                          </View>
                        )}
                      </>
                    )}
                    
                    {currentActivity.type === 'activity' && (
                      <>
                        <View style={styles.activityRow}>
                          <Text style={styles.activityLabel}>Activity Type:</Text>
                          <Text style={styles.activityValue}>{currentActivity.activity_type}</Text>
                        </View>
                        {currentActivity.description && (
                          <View style={styles.activityRow}>
                            <Text style={styles.activityLabel}>Description:</Text>
                            <Text style={styles.activityValue} numberOfLines={2}>
                              {currentActivity.description}
                            </Text>
                          </View>
                        )}
                      </>
                    )}
                  </View>
                </View>
              )}
              
              {/* Historical Activity Summary */}
              <Text style={styles.sectionTitle}>Historical Activity Summary ({activityLogs.length} total logs)</Text>
              {(() => {
                const activitySummary = processActivityLogs(activityLogs);
                return activitySummary.length === 0 ? (
                  <Text style={styles.emptyText}>No historical activity logs found</Text>
                ) : (
                  <>
                    {activitySummary.map((summary, index) => (
                      <View key={summary.activity_type} style={styles.summaryCard}>
                        <View style={styles.summaryHeader}>
                          <Text style={styles.summaryTitle}>{summary.activity_type}</Text>
                          <Text style={styles.summaryCount}>{summary.frequency} times</Text>
                        </View>
                        <View style={styles.summaryDetails}>
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Last Occurrence:</Text>
                            <Text style={styles.summaryValue}>{formatTime(summary.last_occurrence)}</Text>
                          </View>
                          {summary.total_duration > 0 && (
                            <>
                              <View style={styles.summaryRow}>
                                <Text style={styles.summaryLabel}>Total Duration:</Text>
                                <Text style={styles.summaryValue}>{formatDuration(summary.total_duration)}</Text>
                              </View>
                              <View style={styles.summaryRow}>
                                <Text style={styles.summaryLabel}>Average Duration:</Text>
                                <Text style={styles.summaryValue}>{formatDuration(summary.avg_duration)}</Text>
                              </View>
                            </>
                          )}
                        </View>
                      </View>
                    ))}
                  </>
                );
              })()}
            </View>
          )}

          {activeTab === 'apps_web' && (
            <View style={styles.appsWebSection}>
              {selectedDate && (
                <View style={styles.dateFilterHeader}>
                  <Text style={styles.dateFilterText}>Showing data for: {new Date(selectedDate).toLocaleDateString()}</Text>
                  <TouchableOpacity onPress={clearDateFilter} style={styles.clearFilterButton}>
                    <Text style={styles.clearFilterText}>Clear Filter</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Application Summary */}
              <Text style={styles.sectionTitle}>Application Summary ({filteredAppUsage.length} total sessions)</Text>
              {(() => {
                const appSummary = processAppUsage(filteredAppUsage);
                return appSummary.length === 0 ? (
                  <Text style={styles.emptyText}>No app usage data found</Text>
                ) : (
                  <>
                    {appSummary.map((summary, index) => (
                      <TouchableOpacity 
                        key={summary.app_name} 
                        style={styles.summaryCard}
                        onPress={() => navigation.navigate('AppDetail', { 
                          appName: summary.app_name,
                          appData: filteredAppUsage.filter(app => app.app_name === summary.app_name),
                          employeeId: employeeId
                        })}
                      >
                        <View style={styles.summaryHeader}>
                          <Text style={styles.summaryTitle}>{summary.app_name}</Text>
                          <View style={styles.summaryHeaderRight}>
                            <Text style={styles.summaryCount}>{summary.session_count} sessions</Text>
                            {summary.is_active && (
                              <View style={[styles.statusIndicator, { backgroundColor: '#059669' }]}>
                                <Text style={styles.statusText}>Active</Text>
                              </View>
                            )}
                          </View>
                        </View>
                        <View style={styles.summaryDetails}>
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Total Time:</Text>
                            <Text style={styles.summaryValue}>{formatDuration(summary.total_time)}</Text>
                          </View>
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Active Time:</Text>
                            <Text style={styles.summaryValue}>{formatDuration(summary.active_time)}</Text>
                          </View>
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Idle Time:</Text>
                            <Text style={styles.summaryValue}>{formatDuration(summary.idle_time)}</Text>
                          </View>
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Average Session:</Text>
                            <Text style={styles.summaryValue}>{formatDuration(summary.avg_session_duration)}</Text>
                          </View>
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Last Used:</Text>
                            <Text style={styles.summaryValue}>{formatTime(summary.last_used)}</Text>
                          </View>
                          {summary.most_common_title !== 'N/A' && (
                            <View style={styles.summaryRow}>
                              <Text style={styles.summaryLabel}>Most Common:</Text>
                              <Text style={styles.summaryValue} numberOfLines={1}>
                                {summary.most_common_title} ({summary.title_frequency}x)
                              </Text>
                            </View>
                          )}
                        </View>
                      </TouchableOpacity>
                    ))}
                  </>
                );
              })()}

              {/* Web Activity Summary */}
              <Text style={styles.sectionTitle}>Web Activity Summary ({filteredWebActivity.length} total visits)</Text>
              {(() => {
                const webSummary = processWebActivity(filteredWebActivity);
                return webSummary.length === 0 ? (
                  <Text style={styles.emptyText}>No web activity data found</Text>
                ) : (
                  <>
                    {webSummary.map((summary, index) => (
                      <TouchableOpacity 
                        key={summary.domain} 
                        style={styles.summaryCard}
                        onPress={() => navigation.navigate('WebDetail', { 
                          domain: summary.domain,
                          webData: filteredWebActivity.filter(web => {
                            try {
                              const url = new URL(web.url);
                              return url.hostname === summary.domain;
                            } catch {
                              return false;
                            }
                          }),
                          employeeId: employeeId
                        })}
                      >
                        <View style={styles.summaryHeader}>
                          <Text style={styles.summaryTitle}>{summary.domain}</Text>
                          <Text style={styles.summaryCount}>{summary.visit_count} visits</Text>
                        </View>
                        <View style={styles.summaryDetails}>
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Total Time:</Text>
                            <Text style={styles.summaryValue}>{formatDuration(summary.total_time)}</Text>
                          </View>
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Last Visited:</Text>
                            <Text style={styles.summaryValue}>{formatTime(summary.last_visited)}</Text>
                          </View>
                          {summary.most_common_title !== 'N/A' && (
                            <View style={styles.summaryRow}>
                              <Text style={styles.summaryLabel}>Most Common Page:</Text>
                              <Text style={styles.summaryValue} numberOfLines={1}>
                                {summary.most_common_title} ({summary.title_frequency}x)
                              </Text>
                            </View>
                          )}
                        </View>
                      </TouchableOpacity>
                    ))}
                  </>
                );
              })()}
            </View>
          )}

          {activeTab === 'history' && (
            <View style={styles.historySection}>
              <Text style={styles.sectionTitle}>Daily Summaries ({dailySummaries.length} days)</Text>
              
              {dailySummaries.length === 0 ? (
                <Text style={styles.emptyText}>No daily summaries found</Text>
              ) : (
                <>
                  {dailySummaries.map((summary, index) => (
                    <TouchableOpacity 
                      key={summary.id} 
                      style={styles.dateCard}
                      onPress={() => navigation.navigate('DailyDetail', { 
                        date: summary.date,
                        employeeId: employeeId
                      })}
                    >
                      <View style={styles.dateCardHeader}>
                        <Text style={styles.dateCardTitle}>
                          {new Date(summary.date).toLocaleDateString('en-US', { 
                            weekday: 'short',
                            month: 'short', 
                            day: 'numeric',
                            year: 'numeric'
                          })}
                        </Text>
                        <Text style={styles.dateCardCount}>{summary.total_sessions} sessions</Text>
                      </View>
                      <View style={styles.dateCardDetails}>
                        <View style={styles.dateCardRow}>
                          <Text style={styles.dateCardLabel}>Active Time:</Text>
                          <Text style={styles.dateCardValue}>{formatDuration(summary.total_active_time)}</Text>
                        </View>
                        {summary.most_used_app && (
                          <View style={styles.dateCardRow}>
                            <Text style={styles.dateCardLabel}>Top App:</Text>
                            <Text style={styles.dateCardValue}>{summary.most_used_app}</Text>
                          </View>
                        )}
                        {summary.most_visited_domain && (
                          <View style={styles.dateCardRow}>
                            <Text style={styles.dateCardLabel}>Top Site:</Text>
                            <Text style={styles.dateCardValue}>{summary.most_visited_domain}</Text>
                          </View>
                        )}
                      </View>
                    </TouchableOpacity>
                  ))}
                </>
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </View>
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
    marginTop: 12,
    fontSize: 14,
    color: '#6b7280',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  errorText: {
    fontSize: 16,
    color: '#dc2626',
  },
  header: {
    backgroundColor: '#ffffff',
    padding: 12,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  name: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1f2937',
    marginBottom: 6,
  },
  badges: {
    flexDirection: 'row',
    gap: 6,
  },
  roleBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  roleText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#ffffff',
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 9,
    color: '#ffffff',
    fontWeight: '600',
  },
  sessionBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: '#059669',
  },
  sessionText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#ffffff',
  },
  projectIndicator: {
    padding: 4,
    borderRadius: 4,
    backgroundColor: '#f0f9ff',
  },
  projectText: {
    fontSize: 10,
    color: '#1e3a8a',
    fontWeight: '500',
  },
  lastActivityText: {
    fontSize: 10,
    color: '#6b7280',
    marginTop: 4,
  },
  section: {
    backgroundColor: '#ffffff',
    margin: 8,
    borderRadius: 8,
    padding: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  infoGrid: {
    gap: 4,
  },
  infoItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  infoLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: '#6b7280',
  },
  infoValue: {
    fontSize: 11,
    color: '#1f2937',
    fontWeight: '500',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    marginHorizontal: 8,
    marginTop: 8,
    borderRadius: 8,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    borderRadius: 6,
  },
  activeTab: {
    backgroundColor: '#1e3a8a',
  },
  tabText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#6b7280',
  },
  activeTabText: {
    color: '#ffffff',
  },
  scrollableContainer: {
    flex: 1,
    marginTop: 8,
  },
  scrollableContent: {
    flex: 1,
  },
  scrollableContentContainer: {
    paddingBottom: 20,
  },
  overviewSection: {
    padding: 12,
  },
  activitySection: {
    padding: 12,
  },
  appsWebSection: {
    padding: 12,
  },
  historySection: {
    padding: 12,
  },
  liveStatusCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  liveStatusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  liveStatusTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    marginRight: 8,
  },
  statusIndicator: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  liveStatusText: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  currentActivityText: {
    fontSize: 11,
    color: '#059669',
    fontWeight: '500',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  statCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    flex: 1,
    minWidth: '45%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  statNumber: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1e3a8a',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 10,
    color: '#6b7280',
    textAlign: 'center',
  },
  offlineCard: {
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  offlineText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#dc2626',
    marginBottom: 4,
  },
  offlineSubtext: {
    fontSize: 12,
    color: '#6b7280',
  },
  loadingCard: {
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  loadingActivityText: {
    fontSize: 12,
    color: '#1e3a8a',
    marginTop: 8,
  },
  currentActivityCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  activityHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  activityType: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1e3a8a',
  },
  activityTime: {
    fontSize: 10,
    color: '#6b7280',
  },
  activityDetails: {
    gap: 4,
  },
  activityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  activityLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: '#6b7280',
    flex: 1,
  },
  activityValue: {
    fontSize: 11,
    color: '#1f2937',
    flex: 2,
    textAlign: 'right',
  },
  summaryCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  summaryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  summaryTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1f2937',
  },
  summaryCount: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '500',
  },
  summaryDetails: {
    gap: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: '#6b7280',
    flex: 1,
  },
  summaryValue: {
    fontSize: 11,
    color: '#1f2937',
    flex: 2,
    textAlign: 'right',
  },
  emptyText: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'center',
    fontStyle: 'italic',
    marginTop: 20,
  },
  debugText: {
    fontSize: 10,
    color: '#6b7280',
    marginBottom: 8,
  },
  dateCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  dateCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  dateCardTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1f2937',
  },
  dateCardCount: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '500',
  },
  dateCardDetails: {
    gap: 4,
  },
  dateCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  dateCardLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: '#6b7280',
    flex: 1,
  },
  dateCardValue: {
    fontSize: 11,
    color: '#1f2937',
    flex: 2,
    textAlign: 'right',
  },
  dateFilterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  dateFilterText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1e3a8a',
  },
  clearFilterButton: {
    backgroundColor: '#dc2626',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  clearFilterText: {
    fontSize: 10,
    color: '#ffffff',
    fontWeight: '500',
  },
  actionButtonsContainer: {
    flexDirection: 'column',
    gap: 8,
    marginTop: 12,
  },
  actionButtonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  actionButton: {
    backgroundColor: '#ffffff',
    padding: 12,
    borderRadius: 6,
    flex: 1,
    marginHorizontal: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  actionButtonText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#1e3a8a',
    textAlign: 'center',
  },
  deleteButton: {
    backgroundColor: '#fef3c7',
    padding: 12,
    borderRadius: 6,
    flex: 1,
    marginHorizontal: 4,
    borderWidth: 1,
    borderColor: '#f59e0b',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  deleteButtonText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#92400e',
    textAlign: 'center',
  },
  deleteButtonDanger: {
    backgroundColor: '#fef2f2',
    padding: 12,
    borderRadius: 6,
    flex: 1,
    marginHorizontal: 4,
    borderWidth: 1,
    borderColor: '#dc2626',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  summaryHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});

export default EmployeeDetailScreen; 