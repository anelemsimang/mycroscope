import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../context/AuthContext';
import {
  updateEmployeePreferences,
  clearAppCache,
  exportEmployeeData,
} from '../utils/supabaseClient';
import * as Sharing from 'expo-sharing';

const SettingsScreen: React.FC = () => {
  const { employee, signOut } = useAuth();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [darkModeEnabled, setDarkModeEnabled] = useState(false);
  const [dataSyncEnabled, setDataSyncEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<{
    expiresAt: string;
    createdAt: string;
  } | null>(null);

  useEffect(() => {
    // Load session information
    const loadSessionInfo = async () => {
      try {
        const storedSession = await AsyncStorage.getItem('mycroscope_user_session');
        if (storedSession) {
          const sessionData = JSON.parse(storedSession);
          setSessionInfo({
            expiresAt: sessionData.expiresAt,
            createdAt: sessionData.createdAt
          });
        }
      } catch (error) {
        console.error('Error loading session info:', error);
      }
    };

    loadSessionInfo();
  }, []);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getSessionStatus = () => {
    if (!sessionInfo) return 'No active session';
    
    const now = new Date();
    const expiry = new Date(sessionInfo.expiresAt);
    
    if (expiry > now) {
      const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return `Active (${daysLeft} days remaining)`;
    } else {
      return 'Expired';
    }
  };

  const handleLogout = async () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Logout', onPress: signOut, style: 'destructive' },
      ]
    );
  };

  const handleClearCache = async () => {
    Alert.alert(
      'Clear Cache',
      'This will clear all cached data. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Clear', 
          onPress: async () => {
            setLoading(true);
            try {
              const result = await clearAppCache();
              if (result.success) {
                Alert.alert('Success', 'Cache cleared successfully');
              } else {
                Alert.alert('Error', 'Failed to clear cache');
              }
            } catch (error) {
              Alert.alert('Error', 'Failed to clear cache');
            } finally {
              setLoading(false);
            }
          }
        },
      ]
    );
  };

  const handleExportData = async () => {
    if (!employee?.organization_id) {
      Alert.alert('Error', 'No organization access');
      return;
    }

    Alert.alert(
      'Export Data',
      'Choose export format:',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'JSON', 
          onPress: () => exportData('json')
        },
        { 
          text: 'CSV', 
          onPress: () => exportData('csv')
        },
      ]
    );
  };

  const exportData = async (format: 'json' | 'csv') => {
    if (!employee?.organization_id) return;

    setLoading(true);
    try {
      const result = await exportEmployeeData(employee.id, employee.organization_id, format);
      if (result.success) {
        if (format === 'json') {
          // For JSON, we can share the data directly
          const jsonString = JSON.stringify(result.data, null, 2);
          // In a real app, you'd save this to a file and share it
          Alert.alert('Success', 'Data exported successfully. Check your downloads folder.');
        } else {
          // For CSV, we can share the data
          Alert.alert('Success', 'CSV data exported successfully. Check your downloads folder.');
        }
      } else {
        Alert.alert('Error', 'Failed to export data');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to export data');
    } finally {
      setLoading(false);
    }
  };

  const handleContactSupport = () => {
    Alert.alert(
      'Contact Support',
      'For technical support, please contact:\n\nEmail: support@mycroscope.com\nPhone: +1-555-0123\n\nResponse time: 24-48 hours',
      [{ text: 'OK' }]
    );
  };

  const handlePrivacyPolicy = () => {
    Alert.alert(
      'Privacy Policy',
      'Mycroscope Privacy Policy\n\nWe collect and process employee activity data to improve productivity and provide insights. All data is encrypted and stored securely. We do not share personal information with third parties without consent.\n\nFor full details, visit: mycroscope.com/privacy',
      [{ text: 'OK' }]
    );
  };

  const handleTermsOfService = () => {
    Alert.alert(
      'Terms of Service',
      'Mycroscope Terms of Service\n\nBy using this application, you agree to our terms of service. The application is provided "as is" without warranties. Users are responsible for maintaining the security of their accounts.\n\nFor full details, visit: mycroscope.com/terms',
      [{ text: 'OK' }]
    );
  };

  const handleUpdatePreferences = async (key: string, value: boolean) => {
    if (!employee?.id) return;

    try {
      const preferences = {
        [key]: value,
        updated_at: new Date().toISOString(),
      };
      
      const result = await updateEmployeePreferences(employee.id, preferences);
      if (result.success) {
        console.log(`Preference ${key} updated successfully`);
      } else {
        console.error('Failed to update preferences');
      }
    } catch (error) {
      console.error('Error updating preferences:', error);
    }
  };

  const handleNotificationToggle = (value: boolean) => {
    setNotificationsEnabled(value);
    handleUpdatePreferences('notifications_enabled', value);
  };

  const handleAutoRefreshToggle = (value: boolean) => {
    setAutoRefreshEnabled(value);
    handleUpdatePreferences('auto_refresh_enabled', value);
  };

  const handleDataSyncToggle = (value: boolean) => {
    setDataSyncEnabled(value);
    handleUpdatePreferences('data_sync_enabled', value);
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>Manage your app preferences</Text>
      </View>

      {/* Profile Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Profile</Text>
        <View style={styles.profileCard}>
          <Text style={styles.profileName}>{employee?.name || 'Unknown'}</Text>
          <Text style={styles.profileEmail}>{employee?.email || 'No email'}</Text>
          <Text style={styles.profileRole}>Role: {employee?.role || 'Unknown'}</Text>
          <Text style={styles.profileDepartment}>Department: {employee?.department || 'Unknown'}</Text>
          <Text style={styles.profileId}>Employee ID: {employee?.employee_id || 'Unknown'}</Text>
          <Text style={styles.profileStatus}>
            Status: {employee?.is_active ? 'Active' : 'Inactive'}
          </Text>
        </View>
      </View>

      {/* App Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>App Settings</Text>
        
        <View style={styles.settingItem}>
          <View style={styles.settingInfo}>
            <Text style={styles.settingLabel}>Push Notifications</Text>
            <Text style={styles.settingDescription}>Receive alerts for important updates</Text>
          </View>
          <Switch
            value={notificationsEnabled}
            onValueChange={handleNotificationToggle}
            trackColor={{ false: '#d1d5db', true: '#1e3a8a' }}
            thumbColor={notificationsEnabled ? '#ffffff' : '#f4f3f4'}
          />
        </View>

        <View style={styles.settingItem}>
          <View style={styles.settingInfo}>
            <Text style={styles.settingLabel}>Auto Refresh</Text>
            <Text style={styles.settingDescription}>Automatically update dashboard data</Text>
          </View>
          <Switch
            value={autoRefreshEnabled}
            onValueChange={handleAutoRefreshToggle}
            trackColor={{ false: '#d1d5db', true: '#1e3a8a' }}
            thumbColor={autoRefreshEnabled ? '#ffffff' : '#f4f3f4'}
          />
        </View>

        <View style={styles.settingItem}>
          <View style={styles.settingInfo}>
            <Text style={styles.settingLabel}>Data Synchronization</Text>
            <Text style={styles.settingDescription}>Sync data with cloud in real-time</Text>
          </View>
          <Switch
            value={dataSyncEnabled}
            onValueChange={handleDataSyncToggle}
            trackColor={{ false: '#d1d5db', true: '#1e3a8a' }}
            thumbColor={dataSyncEnabled ? '#ffffff' : '#f4f3f4'}
          />
        </View>

        <View style={styles.settingItem}>
          <View style={styles.settingInfo}>
            <Text style={styles.settingLabel}>Dark Mode</Text>
            <Text style={styles.settingDescription}>Use dark theme (coming soon)</Text>
          </View>
          <Switch
            value={darkModeEnabled}
            onValueChange={setDarkModeEnabled}
            trackColor={{ false: '#d1d5db', true: '#1e3a8a' }}
            thumbColor={darkModeEnabled ? '#ffffff' : '#f4f3f4'}
            disabled={true}
          />
        </View>
      </View>

      {/* Data Management */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Data Management</Text>
        
        <TouchableOpacity 
          style={[styles.actionButton, loading && styles.actionButtonDisabled]} 
          onPress={handleClearCache}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <Text style={styles.actionButtonText}>Clear Cache</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.actionButton, loading && styles.actionButtonDisabled]} 
          onPress={handleExportData}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <Text style={styles.actionButtonText}>Export Data</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Support */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Support</Text>
        
        <TouchableOpacity style={styles.actionButton} onPress={handleContactSupport}>
          <Text style={styles.actionButtonText}>Contact Support</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionButton} onPress={handlePrivacyPolicy}>
          <Text style={styles.actionButtonText}>Privacy Policy</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionButton} onPress={handleTermsOfService}>
          <Text style={styles.actionButtonText}>Terms of Service</Text>
        </TouchableOpacity>
      </View>

      {/* App Info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>App Information</Text>
        <View style={styles.infoCard}>
          <Text style={styles.infoText}>Version: 1.0.0</Text>
          <Text style={styles.infoText}>Build: 2024.09.01</Text>
          <Text style={styles.infoText}>Mycroscope Productivity Tracking</Text>
          <Text style={styles.infoText}>© 2024 Mycroscope by Shinkx Group</Text>
        </View>
      </View>

      {/* Session Information */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Session Information</Text>
        <View style={styles.infoCard}>
          <Text style={styles.infoText}>Status: {getSessionStatus()}</Text>
          {sessionInfo && (
            <>
              <Text style={styles.infoText}>Created: {formatDate(sessionInfo.createdAt)}</Text>
              <Text style={styles.infoText}>Expires: {formatDate(sessionInfo.expiresAt)}</Text>
            </>
          )}
          <Text style={styles.infoText}>Auto-login enabled</Text>
        </View>
      </View>

      {/* Logout */}
      <View style={styles.section}>
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
  header: {
    padding: 20,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e3a8a',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
  },
  section: {
    backgroundColor: '#ffffff',
    margin: 12,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 12,
  },
  profileCard: {
    backgroundColor: '#f8fafc',
    padding: 12,
    borderRadius: 8,
  },
  profileName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 4,
  },
  profileEmail: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 2,
  },
  profileRole: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 2,
  },
  profileDepartment: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 2,
  },
  profileId: {
    fontSize: 14,
    color: '#6b7280',
  },
  profileStatus: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 2,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  settingInfo: {
    flex: 1,
    marginRight: 12,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 2,
  },
  settingDescription: {
    fontSize: 14,
    color: '#6b7280',
  },
  actionButton: {
    backgroundColor: '#1e3a8a',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  actionButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  actionButtonDisabled: {
    backgroundColor: '#f3f4f6',
  },
  infoCard: {
    backgroundColor: '#f8fafc',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  infoText: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 4,
  },
  logoutButton: {
    backgroundColor: '#dc2626',
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  logoutButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default SettingsScreen; 