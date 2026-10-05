import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Employee } from '../utils/supabaseClient';

interface EmployeeCardProps {
  employee: Employee;
  status?: 'Online' | 'Offline';
  onPress?: () => void;
  showDetails?: boolean;
}

const EmployeeCard: React.FC<EmployeeCardProps> = ({
  employee,
  status = 'Offline',
  onPress,
  showDetails = true,
}) => {
  const getStatusColor = (status: string) => {
    return status === 'Online' ? '#059669' : '#dc2626';
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

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      disabled={!onPress}
    >
      <View style={styles.header}>
        <View style={styles.nameSection}>
          <Text style={styles.name}>{employee.name}</Text>
          <View style={[styles.roleBadge, { backgroundColor: getRoleColor(employee.role) }]}>
            <Text style={styles.roleText}>{employee.role.toUpperCase()}</Text>
          </View>
        </View>
        <View style={styles.statusSection}>
          <View style={[styles.statusDot, { backgroundColor: getStatusColor(status) }]} />
          <Text style={[styles.statusText, { color: getStatusColor(status) }]}>
            {status}
          </Text>
        </View>
      </View>

      {showDetails && (
        <View style={styles.details}>
          <Text style={styles.detailText}>ID: {employee.employee_id}</Text>
          <Text style={styles.detailText}>Email: {employee.email}</Text>
          <Text style={styles.detailText}>Department: {employee.department}</Text>
          {employee.position && (
            <Text style={styles.detailText}>Position: {employee.position}</Text>
          )}
          <Text style={styles.detailText}>
            Status: {employee.is_active ? 'Active' : 'Inactive'}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    marginVertical: 4,
    marginHorizontal: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  nameSection: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginRight: 8,
  },
  roleBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  roleText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#ffffff',
  },
  statusSection: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  details: {
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    paddingTop: 8,
  },
  detailText: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 2,
  },
});

export default EmployeeCard; 