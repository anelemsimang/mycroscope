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

type WebDetailRouteProp = RouteProp<RootStackParamList, 'WebDetail'>;

interface WebActivity {
  id: string;
  url: string;
  title?: string;
  domain?: string;
  start_time: string;
  end_time?: string;
  duration_seconds?: number;
  is_active?: boolean;
}

const WebDetailScreen: React.FC = () => {
  const route = useRoute<WebDetailRouteProp>();
  const navigation = useNavigation();
  const { domain, webData, employeeId } = route.params;

  const [timelineData, setTimelineData] = useState<WebActivity[]>([]);
  const [summary, setSummary] = useState({
    totalVisits: 0,
    totalTime: 0,
    lastVisited: '',
    mostCommonPage: '',
    pageFrequency: 0,
  });

  useEffect(() => {
    if (webData && webData.length > 0) {
      // Sort by start_time to create chronological timeline
      const sortedData = [...webData].sort((a, b) => 
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
      );
      setTimelineData(sortedData);

      // Calculate summary statistics
      const totalVisits = sortedData.length;
      const totalTime = sortedData.reduce((sum, visit) => 
        sum + (visit.duration_seconds || 0), 0
      );
      const lastVisited = sortedData[sortedData.length - 1]?.start_time || '';
      
      // Find most common page title
      const pageCounts: { [key: string]: number } = {};
      sortedData.forEach(visit => {
        const title = visit.title || 'Unknown Page';
        pageCounts[title] = (pageCounts[title] || 0) + 1;
      });
      
      const mostCommonPage = Object.keys(pageCounts).reduce((a, b) => 
        pageCounts[a] > pageCounts[b] ? a : b
      );
      const pageFrequency = pageCounts[mostCommonPage];

      setSummary({
        totalVisits,
        totalTime,
        lastVisited,
        mostCommonPage,
        pageFrequency,
      });
    }
  }, [webData]);

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

  const getStatusIcon = (visit: WebActivity): string => {
    if (!visit.end_time) return '🟢'; // Still active
    if (visit.is_active === false) return '🟡'; // Tab inactive
    return '🔴'; // Closed
  };

  const getStatusText = (visit: WebActivity): string => {
    if (!visit.end_time) return 'Active';
    if (visit.is_active === false) return 'Tab Inactive';
    return 'Closed';
  };

  const getPagePath = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname || '/';
    } catch {
      return '/';
    }
  };

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.domainName}>🌐 {domain}</Text>
        <Text style={styles.subtitle}>Detailed Timeline</Text>
      </View>

      {/* Summary Card */}
      <View style={styles.summaryCard}>
        <Text style={styles.summaryTitle}>📊 Summary</Text>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Total Visits:</Text>
          <Text style={styles.summaryValue}>{summary.totalVisits}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Total Time:</Text>
          <Text style={styles.summaryValue}>{formatDuration(summary.totalTime)}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Last Visited:</Text>
          <Text style={styles.summaryValue}>{formatTime(summary.lastVisited)}</Text>
        </View>
        {summary.mostCommonPage && summary.mostCommonPage !== 'Unknown Page' && (
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Most Common Page:</Text>
            <Text style={styles.summaryValue} numberOfLines={1}>
              {summary.mostCommonPage} ({summary.pageFrequency}x)
            </Text>
          </View>
        )}
      </View>

      {/* Timeline */}
      <View style={styles.timelineContainer}>
        <Text style={styles.timelineTitle}>
          📅 Timeline ({timelineData.length} visits)
        </Text>
        
        {timelineData.length === 0 ? (
          <Text style={styles.emptyText}>No web activity data found</Text>
        ) : (
          timelineData.map((visit, index) => (
            <View key={visit.id} style={styles.timelineItem}>
              <View style={styles.timelineHeader}>
                <Text style={styles.timelineTime}>
                  {formatDateTime(visit.start_time)}
                </Text>
                <View style={styles.statusContainer}>
                  <Text style={styles.statusIcon}>{getStatusIcon(visit)}</Text>
                  <Text style={styles.statusText}>{getStatusText(visit)}</Text>
                </View>
              </View>
              
              <View style={styles.timelineContent}>
                <Text style={styles.timelineAction}>
                  Page {visit.end_time ? 'Visit' : 'Loaded'}
                </Text>
                
                {visit.title && (
                  <Text style={styles.pageTitle}>
                    📄 {visit.title}
                  </Text>
                )}
                
                <Text style={styles.pageUrl}>
                  🔗 {visit.url}
                </Text>
                
                <Text style={styles.pagePath}>
                  📁 Path: {getPagePath(visit.url)}
                </Text>
                
                {visit.duration_seconds && (
                  <Text style={styles.duration}>
                    ⏱️ Duration: {formatDuration(visit.duration_seconds)}
                  </Text>
                )}
                
                {visit.end_time && (
                  <Text style={styles.endTime}>
                    Ended: {formatDateTime(visit.end_time)}
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
    backgroundColor: '#059669', // Green for web
    padding: 20,
    alignItems: 'center',
  },
  domainName: {
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
    backgroundColor: '#f0fdf4', // Light green background
    padding: 15,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#059669',
  },
  timelineAction: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 5,
  },
  pageTitle: {
    fontSize: 13,
    color: '#374151',
    marginBottom: 5,
    fontStyle: 'italic',
  },
  pageUrl: {
    fontSize: 12,
    color: '#059669',
    marginBottom: 3,
    fontFamily: 'monospace',
  },
  pagePath: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 3,
    fontFamily: 'monospace',
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

export default WebDetailScreen; 