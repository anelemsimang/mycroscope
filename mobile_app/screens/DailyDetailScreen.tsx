import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import {
  getAppUsage,
  getWebActivity,
  getActivityLogs,
  getEmployeeByEmployeeId,
  AppUsage,
  WebActivity,
  ActivityLog,
} from '../utils/supabaseClient';

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

const DailyDetailScreen: React.FC = () => {
  const route = useRoute();
  const navigation = useNavigation();
  const { date, employeeId } = route.params as { date: string; employeeId: string };
  const { employee } = useAuth();
  
  const [appUsage, setAppUsage] = useState<AppUsage[]>([]);
  const [webActivity, setWebActivity] = useState<WebActivity[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (date && employeeId && employee?.organization_id) {
      loadDailyData();
    }
  }, [date, employeeId, employee]);

  const loadDailyData = async () => {
    try {
      setLoading(true);
      
      // Get the employee UUID first
      const employeeData = await getEmployeeByEmployeeId(employeeId, employee?.organization_id);
      if (!employeeData) {
        Alert.alert('Error', 'Employee not found');
        return;
      }

      // Set date range for the specific day
      const startOfDay = new Date(date);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const [logsData, appsData, webData] = await Promise.all([
        getActivityLogs(employee?.organization_id, employeeData.id, startOfDay.toISOString(), endOfDay.toISOString()),
        getAppUsage(employee?.organization_id, employeeData.id, startOfDay.toISOString(), endOfDay.toISOString()),
        getWebActivity(employee?.organization_id, employeeData.id, startOfDay.toISOString(), endOfDay.toISOString()),
      ]);

      setActivityLogs(logsData);
      setAppUsage(appsData);
      setWebActivity(webData);
    } catch (error) {
      console.error('Error loading daily data:', error);
      Alert.alert('Error', 'Failed to load daily data');
    } finally {
      setLoading(false);
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

  // Data processing functions (same as EmployeeDetailScreen)
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
          active_time: 0
        };
      }
      
      const duration = app.duration_seconds || 0;
      acc[app.app_name].total_time += duration;
      acc[app.app_name].session_count += 1;
      acc[app.app_name].sessions.push(app);
      
      // Calculate active vs idle time (simplified logic)
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
      
      return acc;
    }, {} as Record<string, any>);

    return Object.values(grouped).map(app => {
      const mostCommonTitle = Object.entries(app.titles)
        .sort(([,a], [,b]) => (b as number) - (a as number))[0];
      
      return {
        app_name: app.app_name,
        total_time: app.total_time,
        session_count: app.session_count,
        last_used: app.last_used,
        avg_session_duration: app.total_time / app.session_count,
        most_common_title: mostCommonTitle ? mostCommonTitle[0] : 'N/A',
        title_frequency: mostCommonTitle ? mostCommonTitle[1] as number : 0,
        idle_time: app.idle_time,
        active_time: app.active_time
      };
    }).sort((a, b) => b.total_time - a.total_time);
  };

  const processWebActivity = (websites: WebActivity[]): WebSummary[] => {
    const grouped = websites.reduce((acc, web) => {
      let domain = 'Unknown';
      try {
        const url = new URL(web.url);
        domain = url.hostname;
      } catch (error) {
        console.log('Invalid URL:', web.url);
        domain = 'Invalid URL';
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
      acc[domain].visit_count += 1;
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
      const mostCommonTitle = Object.entries(group.titles)
        .sort(([,a]: any, [,b]: any) => b - a)[0] || ['N/A', 0];
      
      return {
        domain: group.domain,
        total_time: group.total_time,
        visit_count: group.visit_count,
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

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1e3a8a" />
        <Text style={styles.loadingText}>Loading daily details...</Text>
      </View>
    );
  }

  const formattedDate = new Date(date).toLocaleDateString('en-US', { 
    weekday: 'long',
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{formattedDate}</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Daily Summary Stats */}
        <View style={styles.summaryStats}>
          <View style={styles.statCard}>
            <Text style={styles.statNumber}>{appUsage.length + webActivity.length}</Text>
            <Text style={styles.statLabel}>Total Sessions</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statNumber}>
              {Math.round((appUsage.reduce((sum, app) => sum + (app.duration_seconds || 0), 0) + 
                          webActivity.reduce((sum, web) => sum + (web.duration_seconds || 0), 0)) / 3600 * 10) / 10}
            </Text>
            <Text style={styles.statLabel}>Total Hours</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statNumber}>{new Set(appUsage.map(app => app.app_name)).size}</Text>
            <Text style={styles.statLabel}>Apps Used</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statNumber}>{new Set(webActivity.map(web => web.domain)).size}</Text>
            <Text style={styles.statLabel}>Websites</Text>
          </View>
        </View>

        {/* Application Summary */}
        <Text style={styles.sectionTitle}>Application Summary ({appUsage.length} total sessions)</Text>
        {(() => {
          const appSummary = processAppUsage(appUsage);
          return appSummary.length === 0 ? (
            <Text style={styles.emptyText}>No app usage data found for this day</Text>
          ) : (
            <>
              {appSummary.map((summary, index) => (
                <TouchableOpacity 
                  key={summary.app_name} 
                  style={styles.summaryCard}
                  onPress={() => navigation.navigate('AppDetail', { 
                    appName: summary.app_name,
                    appData: appUsage.filter(app => app.app_name === summary.app_name),
                    employeeId: employeeId
                  })}
                >
                  <View style={styles.summaryHeader}>
                    <Text style={styles.summaryTitle}>{summary.app_name}</Text>
                    <Text style={styles.summaryCount}>{summary.session_count} sessions</Text>
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
        <Text style={styles.sectionTitle}>Web Activity Summary ({webActivity.length} total visits)</Text>
        {(() => {
          const webSummary = processWebActivity(webActivity);
          return webSummary.length === 0 ? (
            <Text style={styles.emptyText}>No web activity data found for this day</Text>
          ) : (
            <>
              {webSummary.map((summary, index) => (
                <TouchableOpacity 
                  key={summary.domain} 
                  style={styles.summaryCard}
                  onPress={() => navigation.navigate('WebDetail', { 
                    domain: summary.domain,
                    webData: webActivity.filter(web => {
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

        {/* Activity Logs Summary */}
        <Text style={styles.sectionTitle}>Activity Logs ({activityLogs.length} total logs)</Text>
        {(() => {
          const activitySummary = processActivityLogs(activityLogs);
          return activitySummary.length === 0 ? (
            <Text style={styles.emptyText}>No activity logs found for this day</Text>
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
      </ScrollView>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backButton: {
    padding: 8,
  },
  backButtonText: {
    fontSize: 16,
    color: '#1e3a8a',
    fontWeight: '500',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
  },
  placeholder: {
    width: 50,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  summaryStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  statCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    flex: 1,
    marginHorizontal: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  statNumber: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e3a8a',
  },
  statLabel: {
    fontSize: 10,
    color: '#6b7280',
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 12,
    marginTop: 8,
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
});

export default DailyDetailScreen; 