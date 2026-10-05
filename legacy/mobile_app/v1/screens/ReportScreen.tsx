import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import {
  getAllEmployees,
  getEmployeeByEmployeeId,
  getAppUsage,
  getWebActivity,
  getActivityLogs,
  getEmployeeProjects,
  Employee,
} from '../utils/supabaseClient';
import { defaultReportGenerator, ReportData } from '../utils/reportTemplates';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

const periods = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 Days' },
  { key: 'month', label: 'Last Month' },
  { key: 'quarter', label: 'Last Quarter' },
];

const ReportScreen: React.FC = () => {
  const { employee } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<string>('');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('week');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<string[]>([]);

  useEffect(() => {
    if (employee?.organization_id) {
      loadEmployees();
    }
  }, [employee]);

  useEffect(() => {
    if (selectedEmployee && employee?.organization_id) {
      loadAvailableProjects();
    }
  }, [selectedEmployee, employee?.organization_id]);

  const loadEmployees = async () => {
    if (!employee?.organization_id) return;
    
    try {
      const employeesData = await getAllEmployees(employee.organization_id);
      setEmployees(employeesData);
    } catch (error) {
      Alert.alert('Error', 'Failed to load employees');
    }
  };

  const loadAvailableProjects = async () => {
    if (!selectedEmployee || !employee?.organization_id) return;

    try {
      const employeeData = await getEmployeeByEmployeeId(selectedEmployee, employee.organization_id);
      if (!employeeData) return;

      // Use the new getEmployeeProjects function to get all projects the employee has worked on
      const employeeProjects = await getEmployeeProjects(employeeData.id, employee.organization_id);
      
      // Extract project names
      const projectNames = employeeProjects.map(project => project.name);
      setAvailableProjects(projectNames);
      
    } catch (error) {
      console.error('Error loading projects:', error);
    }
  };

  const getDateRange = (period: string) => {
    const now = new Date();
    const startDate = new Date();
    
    switch (period) {
      case 'today':
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'week':
        startDate.setDate(now.getDate() - 7);
        break;
      case 'month':
        startDate.setMonth(now.getMonth() - 1);
        break;
      case 'quarter':
        startDate.setMonth(now.getMonth() - 3);
        break;
      default:
        startDate.setHours(0, 0, 0, 0);
    }
    
    return {
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
    };
  };

  const generateProfessionalReport = async () => {
    if (!employee?.organization_id) {
      Alert.alert('Error', 'No organization access');
      return;
    }

    if (!selectedEmployee) {
      Alert.alert('Error', 'Please select an employee');
      return;
    }

    setGenerating(true);
    try {
      const { startDate, endDate } = getDateRange(selectedPeriod);
      
      // Get employee data
      const employeeData = await getEmployeeByEmployeeId(selectedEmployee, employee.organization_id);
      if (!employeeData) {
        Alert.alert('Error', 'Employee not found');
        return;
      }

      // Fetch all required data
      const [appUsage, webActivity, activityLogs] = await Promise.all([
        getAppUsage(employee.organization_id, employeeData.id, startDate, endDate),
        getWebActivity(employee.organization_id, employeeData.id, startDate, endDate),
        getActivityLogs(employee.organization_id, employeeData.id, startDate, endDate),
      ]);

      // Filter data by project if selected
      let filteredAppUsage = appUsage;
      let filteredWebActivity = webActivity;
      let filteredActivityLogs = activityLogs;

      if (selectedProject) {
        // Filter activity logs by project
        filteredActivityLogs = activityLogs.filter(log => 
          log.metadata?.current_project === selectedProject
        );
        
        // Filter app usage by current_project field directly
        if (selectedProject === 'No Project') {
          // Show only records with NULL/empty project values
          filteredAppUsage = appUsage.filter(app => 
            !app.current_project || app.current_project === null || app.current_project === ''
          );
        } else {
          // Show only records with the specific project
          filteredAppUsage = appUsage.filter(app => 
            app.current_project === selectedProject
          );
        }
        
        // Filter web activity by current_project field directly
        if (selectedProject === 'No Project') {
          // Show only records with NULL/empty project values
          filteredWebActivity = webActivity.filter(web => 
            !web.current_project || web.current_project === null || web.current_project === ''
          );
        } else {
          // Show only records with the specific project
          filteredWebActivity = webActivity.filter(web => 
            web.current_project === selectedProject
          );
        }
      }

      // Prepare report data
      const reportData: ReportData = {
        employee: employeeData,
        period: selectedPeriod,
        startDate,
        endDate,
        appUsage: filteredAppUsage,
        webActivity: filteredWebActivity,
        activityLogs: filteredActivityLogs,
        analytics: null,
        projectFilter: selectedProject,
      };

      // Generate professional report HTML
      const html = defaultReportGenerator.generateProfessionalReport(reportData);
      
      // Generate and share PDF
      await generateAndSharePDF(html, employeeData.name);
      
    } catch (error) {
      console.error('Error generating report:', error);
      Alert.alert('Error', 'Failed to generate professional report');
    } finally {
      setGenerating(false);
    }
  };

  const generateAndSharePDF = async (html: string, employeeName: string) => {
    try {
      const { uri } = await Print.printToFileAsync({
        html,
        base64: false,
      });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: `Professional Report - ${employeeName}`,
        });
      } else {
        Alert.alert('Success', 'Report generated successfully!');
      }
    } catch (error) {
      console.error('Error generating PDF:', error);
      Alert.alert('Error', 'Failed to generate PDF');
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Professional Report</Text>
          <Text style={styles.subtitle}>
            Generate beautiful, detailed productivity reports
          </Text>
        </View>

        {/* Employee Selection */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Select Employee</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.employeeScroll}>
            <TouchableOpacity
              style={[styles.employeeCard, selectedEmployee === '' && styles.selectedCard]}
              onPress={() => setSelectedEmployee('')}
            >
              <Text style={styles.employeeName}>👥 All Employees</Text>
            </TouchableOpacity>
            {employees.map((emp) => (
              <TouchableOpacity
                key={emp.employee_id}
                style={[styles.employeeCard, selectedEmployee === emp.employee_id && styles.selectedCard]}
                onPress={() => setSelectedEmployee(emp.employee_id)}
              >
                <Text style={styles.employeeName}>{emp.name}</Text>
                <Text style={styles.employeeRole}>{emp.role}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Period Selection */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Select Period</Text>
          <View style={styles.periodGrid}>
            {periods.map((period) => (
              <TouchableOpacity
                key={period.key}
                style={[styles.periodCard, selectedPeriod === period.key && styles.selectedCard]}
                onPress={() => setSelectedPeriod(period.key)}
              >
                <Text style={styles.periodLabel}>{period.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Project Selection */}
        {selectedEmployee && availableProjects.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Select Project (Optional)</Text>
            <TouchableOpacity
              style={styles.projectSelector}
              onPress={() => setShowProjectModal(true)}
            >
              <Text style={styles.projectSelectorText}>
                {selectedProject ? `📁 ${selectedProject}` : '🌐 All Projects'}
              </Text>
              <Text style={styles.projectSelectorArrow}>▼</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Generate Button */}
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.generateButton, !selectedEmployee && styles.disabledButton]}
            onPress={generateProfessionalReport}
            disabled={!selectedEmployee || generating}
          >
            {generating ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <Text style={styles.generateButtonText}>📊 Generate Professional Report</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Report Preview Info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Report Preview</Text>
          <View style={styles.previewCard}>
            <Text style={styles.previewTitle}>What's included:</Text>
            <View style={styles.previewList}>
              <Text style={styles.previewItem}>📈 Executive Summary with Key Metrics</Text>
              <Text style={styles.previewItem}>💻 Detailed Application Usage Analysis</Text>
              <Text style={styles.previewItem}>🌐 Web Activity Overview</Text>
              <Text style={styles.previewItem}>📊 Productivity Trends & Insights</Text>
              <Text style={styles.previewItem}>🎯 Professional Layout & Branding</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Project Selection Modal */}
      <Modal
        visible={showProjectModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowProjectModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Select Project</Text>
            <ScrollView style={styles.modalScroll}>
              <TouchableOpacity
                style={styles.modalOption}
                onPress={() => {
                  setSelectedProject(null);
                  setShowProjectModal(false);
                }}
              >
                <Text style={styles.modalOptionText}>🌐 All Projects</Text>
              </TouchableOpacity>
              {availableProjects.map((project) => (
                <TouchableOpacity
                  key={project}
                  style={styles.modalOption}
                  onPress={() => {
                    setSelectedProject(project);
                    setShowProjectModal(false);
                  }}
                >
                  <Text style={styles.modalOptionText}>📁 {project}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => setShowProjectModal(false)}
            >
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scrollView: {
    flex: 1,
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
    color: '#1f2937',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#6b7280',
    lineHeight: 22,
  },
  section: {
    backgroundColor: '#ffffff',
    margin: 16,
    marginTop: 8,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 16,
  },
  employeeScroll: {
    flexDirection: 'row',
  },
  employeeCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 16,
    marginRight: 12,
    minWidth: 120,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  selectedCard: {
    backgroundColor: '#1e3a8a',
    borderColor: '#1e3a8a',
  },
  employeeName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 4,
  },
  employeeRole: {
    fontSize: 12,
    color: '#6b7280',
  },
  periodGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  periodCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 16,
    flex: 1,
    minWidth: '45%',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  periodLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1f2937',
  },
  projectSelector: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  projectSelectorText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1f2937',
  },
  projectSelectorArrow: {
    fontSize: 12,
    color: '#6b7280',
  },
  generateButton: {
    backgroundColor: '#1e3a8a',
    borderRadius: 12,
    padding: 18,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  disabledButton: {
    backgroundColor: '#9ca3af',
  },
  generateButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  previewCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#1e3a8a',
  },
  previewTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 12,
  },
  previewList: {
    gap: 8,
  },
  previewItem: {
    fontSize: 14,
    color: '#374151',
    lineHeight: 20,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 20,
    width: '80%',
    maxHeight: '60%',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 16,
    textAlign: 'center',
  },
  modalScroll: {
    maxHeight: 300,
  },
  modalOption: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  modalOptionText: {
    fontSize: 16,
    color: '#1f2937',
  },
  modalCloseButton: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    alignItems: 'center',
  },
  modalCloseText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#374151',
  },
});

export default ReportScreen; 