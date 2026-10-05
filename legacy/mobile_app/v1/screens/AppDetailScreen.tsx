import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { RouteProp, useRoute, useNavigation } from '@react-navigation/native';
import { RootStackParamList } from '../navigation/MainNavigator';

type AppDetailRouteProp = RouteProp<RootStackParamList, 'AppDetail'>;

interface AppUsage {
  id: string;
  employee_id: string;
  organization_id: string;
  session_id?: string;
  app_name: string;
  window_title?: string;
  start_time: string;
  end_time?: string;
  duration_seconds?: number;
  is_active: boolean;
  created_at: string;
}

const AppDetailScreen: React.FC = () => {
  const route = useRoute<AppDetailRouteProp>();
  const navigation = useNavigation();
  const { appName, appData, employeeId } = route.params;

  const [timelineData, setTimelineData] = useState<AppUsage[]>([]);
  const [summary, setSummary] = useState({
    totalSessions: 0,
    totalTime: 0,
    lastUsed: '',
    mostCommonWindow: '',
    windowFrequency: 0,
  });

  useEffect(() => {
    if (appData && appData.length > 0) {
      // Sort by start_time to create chronological timeline
      const sortedData = [...appData].sort((a, b) => 
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
      );
      setTimelineData(sortedData);

      // Calculate summary statistics
      const totalSessions = sortedData.length;
      const totalTime = sortedData.reduce((sum, session) => 
        sum + (session.duration_seconds || 0), 0
      );
      const lastUsed = sortedData[sortedData.length - 1]?.start_time || '';
      
      // Find most common window title
      const windowCounts: { [key: string]: number } = {};
      sortedData.forEach(session => {
        const title = session.window_title || 'Unknown Window';
        windowCounts[title] = (windowCounts[title] || 0) + 1;
      });
      
      const mostCommonWindow = Object.keys(windowCounts).reduce((a, b) => 
        windowCounts[a] > windowCounts[b] ? a : b
      );
      const windowFrequency = windowCounts[mostCommonWindow];

      setSummary({
        totalSessions,
        totalTime,
        lastUsed,
        mostCommonWindow,
        windowFrequency,
      });
    } else {
      setTimelineData([]);
      setSummary({
        totalSessions: 0,
        totalTime: 0,
        lastUsed: '',
        mostCommonWindow: '',
        windowFrequency: 0,
      });
    }
  }, [appData, appName, employeeId]);

  const formatDuration = (seconds: number): string => {
    if (!seconds) return '0s';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

  const formatTime = (timestamp: string): string => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
    }
  };

  const formatDateTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const getStatusIcon = (session: AppUsage): string => {
    // If no end_time, it's still active
    if (!session.end_time) return '🟢';
    // If is_active is false, it's minimized/inactive
    if (session.is_active === false) return '🟡';
    // If is_active is true but has end_time, it's closed
    if (session.is_active === true) return '🔴';
    // Default to closed if we can't determine
    return '🔴';
  };

  const getStatusText = (session: AppUsage): string => {
    // If no end_time, it's still active
    if (!session.end_time) return 'Active';
    // If is_active is false, it's minimized/inactive
    if (session.is_active === false) return 'Minimized';
    // If is_active is true but has end_time, it's closed
    if (session.is_active === true) return 'Closed';
    // Default to closed if we can't determine
    return 'Closed';
  };

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.appName}>📱 {appName}</Text>
        <Text style={styles.subtitle}>Detailed Timeline</Text>
      </View>

      {/* Summary Card */}
      <View style={styles.summaryCard}>
        <Text style={styles.summaryTitle}>📊 Summary</Text>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Total Sessions:</Text>
          <Text style={styles.summaryValue}>{summary.totalSessions}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Total Time:</Text>
          <Text style={styles.summaryValue}>{formatDuration(summary.totalTime)}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Last Used:</Text>
          <Text style={styles.summaryValue}>{formatTime(summary.lastUsed)}</Text>
        </View>
        {summary.mostCommonWindow && summary.mostCommonWindow !== 'Unknown Window' && (
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Most Common Window:</Text>
            <Text style={styles.summaryValue} numberOfLines={1}>
              {summary.mostCommonWindow} ({summary.windowFrequency}x)
            </Text>
          </View>
        )}
      </View>

      {/* Timeline */}
      <View style={styles.timelineContainer}>
        <Text style={styles.timelineTitle}>
          📅 Timeline ({timelineData.length} sessions)
        </Text>
        
        {timelineData.length === 0 ? (
          <Text style={styles.emptyText}>No app usage data found</Text>
        ) : (
          timelineData.map((session, index) => (
            <View key={session.id} style={styles.timelineItem}>
              <View style={styles.timelineHeader}>
                <Text style={styles.timelineTime}>
                  {formatDateTime(session.start_time)}
                </Text>
                <View style={styles.statusContainer}>
                  <Text style={styles.statusIcon}>{getStatusIcon(session)}</Text>
                  <Text style={styles.statusText}>{getStatusText(session)}</Text>
                </View>
              </View>
              
              <View style={styles.timelineContent}>
                <Text style={styles.timelineAction}>
                  {!session.end_time ? 'App Active' : 
                   session.is_active === false ? 'App Minimized' : 
                   'App Session'}
                </Text>
                
                {session.window_title && (
                  <Text style={styles.windowTitle}>
                    📄 {session.window_title}
                  </Text>
                )}
                
                {session.duration_seconds && (
                  <Text style={styles.duration}>
                    ⏱️ Duration: {formatDuration(session.duration_seconds)}
                  </Text>
                )}
                
                {session.end_time && (
                  <Text style={styles.endTime}>
                    Ended: {formatDateTime(session.end_time)}
                  </Text>
                )}
              </View>
              
              {index < timelineData.length - 1 && (
                <View style={styles.timelineConnector} />
              )}
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    backgroundColor: '#1e3a8a',
    padding: 20,
    alignItems: 'center',
  },
  appName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 5,
  },
  subtitle: {
    fontSize: 16,
    color: '#e5e7eb',
  },
  summaryCard: {
    backgroundColor: '#ffffff',
    margin: 15,
    padding: 20,
    borderRadius: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  summaryTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 15,
    color: '#1f2937',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  summaryLabel: {
    fontSize: 14,
    color: '#6b7280',
    flex: 1,
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    flex: 1,
    textAlign: 'right',
  },
  timelineContainer: {
    backgroundColor: '#ffffff',
    margin: 15,
    padding: 20,
    borderRadius: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  timelineTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 20,
    color: '#1f2937',
  },
  timelineItem: {
    marginBottom: 20,
  },
  timelineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  timelineTime: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusIcon: {
    fontSize: 16,
    marginRight: 5,
  },
  statusText: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
  },
  timelineContent: {
    backgroundColor: '#f9fafb',
    padding: 15,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#3b82f6',
  },
  timelineAction: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 5,
  },
  windowTitle: {
    fontSize: 13,
    color: '#374151',
    marginBottom: 5,
    fontStyle: 'italic',
  },
  duration: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 3,
  },
  endTime: {
    fontSize: 12,
    color: '#6b7280',
  },
  timelineConnector: {
    width: 2,
    height: 20,
    backgroundColor: '#e5e7eb',
    marginLeft: 10,
    marginTop: 5,
  },
  emptyText: {
    textAlign: 'center',
    color: '#6b7280',
    fontSize: 16,
    fontStyle: 'italic',
    marginTop: 20,
  },
});

export default AppDetailScreen; 