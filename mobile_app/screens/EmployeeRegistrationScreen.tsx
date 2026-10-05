import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { supabase } from '../utils/supabaseClient';
import { useAuth } from '../context/AuthContext';

const EmployeeRegistrationScreen: React.FC = () => {
  const { employee } = useAuth();
  const [formData, setFormData] = useState({
    employeeId: '',
    name: '',
    email: '',
    password: '',
    department: '',
    role: 'employee',
  });
  const [loading, setLoading] = useState(false);
  const [currentOrganization, setCurrentOrganization] = useState<any>(null);

  const departments = ['Engineering', 'Management', 'IT', 'Marketing', 'Sales', 'HR'];
  const roles = ['employee', 'manager', 'admin'];

  const generateEmployeeId = (organizationName: string) => {
    if (!organizationName.trim()) return '';
    
    // Create abbreviation from organization name
    const words = organizationName.trim().split(' ');
    let abbreviation = '';
    
    if (words.length === 1) {
      // Single word: take first 3 letters
      abbreviation = words[0].substring(0, 3).toUpperCase();
    } else {
      // Multiple words: take first letter of each word
      abbreviation = words.map(word => word.charAt(0)).join('').toUpperCase();
    }
    
    // Generate random 4-digit number
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    
    return `${abbreviation}${randomNum}`;
  };

  // Load current user's organization info
  useEffect(() => {
    const loadOrganization = async () => {
      console.log('=== LOADING ORGANIZATION ===');
      console.log('Current employee:', employee);
      
      if (employee?.organization_id) {
        console.log('Organization ID found:', employee.organization_id);
        try {
          const { data: org, error } = await supabase
            .from('organizations')
            .select('*')
            .eq('id', employee.organization_id)
            .single();
          
          console.log('Organization query result:', { org, error });
          
          if (org && !error) {
            console.log('Setting organization:', org);
            setCurrentOrganization(org);
            // Auto-generate initial employee ID
            setFormData(prev => ({ 
              ...prev, 
              employeeId: generateEmployeeId(org.name)
            }));
          } else {
            console.error('Failed to load organization:', error);
          }
        } catch (error) {
          console.error('Error loading organization:', error);
        }
      } else {
        console.log('No organization ID found in employee data');
      }
    };

    loadOrganization();
  }, [employee]);

  // Debug form state changes
  useEffect(() => {
    console.log('=== FORM STATE CHANGED ===');
    console.log('Current form data:', formData);
  }, [formData]);

  // Debug component mount
  useEffect(() => {
    console.log('=== COMPONENT MOUNTED ===');
    console.log('Initial form data:', formData);
    console.log('Current employee:', employee);
  }, []);

  const handleRegister = async () => {
    console.log('=== REGISTER BUTTON CLICKED ===');
    console.log('Form data:', formData);
    console.log('Current organization:', currentOrganization);
    
    if (!formData.employeeId || !formData.name || !formData.email || !formData.password) {
      console.log('Validation failed - missing required fields');
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    if (!currentOrganization) {
      console.log('Validation failed - no organization');
      Alert.alert('Error', 'Organization information not available');
      return;
    }

    console.log('Starting registration process...');
    setLoading(true);
    try {
      console.log('Checking for existing employee...');
      console.log('Checking email:', formData.email);
      console.log('Organization ID:', currentOrganization.id);
      
      // Check if employee already exists by email (more reliable than employee_id)
      const { data: existingEmployee, error: checkError } = await supabase
        .from('employees')
        .select('*')
        .eq('email', formData.email)
        .eq('organization_id', currentOrganization.id)
        .single();

      console.log('Existing employee check result:', { existingEmployee, checkError });

      if (existingEmployee && !checkError) {
        console.log('Employee email already exists in this organization');
        console.log('Existing employee data:', existingEmployee);
        Alert.alert('Error', 'An employee with this email already exists in your organization. Please use a different email address.');
        setLoading(false);
        return;
      }

      // Also check if employee ID exists (optional check)
      const { data: existingEmployeeId, error: idCheckError } = await supabase
        .from('employees')
        .select('*')
        .eq('employee_id', formData.employeeId)
        .single();

      if (existingEmployeeId && !idCheckError) {
        console.log('Employee ID already exists, regenerating...');
        Alert.alert('Error', 'Employee ID already exists. Please try again.');
        // Regenerate employee ID
        setFormData(prev => ({ 
          ...prev, 
          employeeId: generateEmployeeId(currentOrganization.name)
        }));
        setLoading(false);
        return;
      }

      console.log('Inserting new employee...');
      // Insert new employee
      const { data, error } = await supabase
        .from('employees')
        .insert([{
          employee_id: formData.employeeId,
          name: formData.name,
          email: formData.email,
          password_hash: formData.password, // In production, hash this
          department: formData.department,
          role: formData.role,
          organization_id: currentOrganization.id,
          is_active: true
        }])
        .select()
        .single();

      console.log('Insert result:', { data, error });

      if (error) {
        console.error('Database error:', error);
        if (error.code === '23505') {
          Alert.alert('Error', 'An employee with this email already exists in your organization. Please use a different email address.');
        } else {
          Alert.alert('Error', error.message);
        }
        return;
      }

      console.log('Employee registered successfully!');
      // Show success message with credentials
      Alert.alert(
        'Employee Registered Successfully!',
        `Employee: ${data.name}\nEmail: ${data.email}\nPassword: ${formData.password}\n\nEmployee can now login to the desktop app using these credentials.`,
        [
          {
            text: 'OK',
            onPress: () => {
              console.log('Resetting form...');
              // Reset form
              setFormData({
                employeeId: generateEmployeeId(currentOrganization.name),
                name: '',
                email: '',
                password: '',
                department: '',
                role: 'employee',
              });
            }
          }
        ]
      );

    } catch (error) {
      console.error('Registration error:', error);
      Alert.alert('Error', 'Failed to register employee');
    } finally {
      console.log('Setting loading to false');
      setLoading(false);
    }
  };

  const generateRandomPassword = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setFormData(prev => ({ ...prev, password }));
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Register New Employee</Text>
        <Text style={styles.subtitle}>Add employee to the tracking system</Text>
      </View>

      <View style={styles.mainContent}>
        <View style={styles.form}>
          {/* Organization Info */}
          {currentOrganization && (
            <View style={styles.organizationInfo}>
              <Text style={styles.organizationText}>
                Registering employee for: <Text style={styles.organizationName}>{currentOrganization.name}</Text>
              </Text>
            </View>
          )}

          {/* Employee Registration Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Employee Details</Text>
            
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Employee ID *</Text>
              <View style={styles.passwordContainer}>
                <TextInput
                  style={[styles.input, styles.passwordInput, styles.readOnlyInput]}
                  value={formData.employeeId}
                  placeholder="Auto-generated"
                  editable={false}
                />
                <TouchableOpacity
                  style={styles.generateButton}
                  onPress={() => {
                    if (currentOrganization) {
                      setFormData(prev => ({ 
                        ...prev, 
                        employeeId: generateEmployeeId(currentOrganization.name)
                      }));
                    }
                  }}
                >
                  <Text style={styles.generateButtonText}>Generate</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Full Name *</Text>
              <TextInput
                style={styles.input}
                value={formData.name}
                onChangeText={(text) => setFormData(prev => ({ ...prev, name: text }))}
                placeholder="Enter full name"
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email *</Text>
              <TextInput
                style={styles.input}
                value={formData.email}
                onChangeText={(text) => setFormData(prev => ({ ...prev, email: text }))}
                placeholder="employee@company.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                textContentType="none"
                onFocus={() => {
                  if (formData.email === '') {
                    setFormData(prev => ({ ...prev, email: '' }));
                  }
                }}
                clearButtonMode="while-editing"
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password *</Text>
              <View style={styles.passwordContainer}>
                <TextInput
                  style={[styles.input, styles.passwordInput]}
                  value={formData.password}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, password: text }))}
                  placeholder="Enter password"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  onFocus={() => {
                    if (formData.password === '') {
                      setFormData(prev => ({ ...prev, password: '' }));
                    }
                  }}
                  clearButtonMode="while-editing"
                />
                <TouchableOpacity
                  style={styles.generateButton}
                  onPress={generateRandomPassword}
                >
                  <Text style={styles.generateButtonText}>Generate</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Department</Text>
              <View style={styles.pickerContainer}>
                {departments.map((dept) => (
                  <TouchableOpacity
                    key={dept}
                    style={[
                      styles.pickerOption,
                      formData.department === dept && styles.pickerOptionSelected
                    ]}
                    onPress={() => setFormData(prev => ({ ...prev, department: dept }))}
                  >
                    <Text style={[
                      styles.pickerOptionText,
                      formData.department === dept && styles.pickerOptionTextSelected
                    ]}>
                      {dept}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Role</Text>
              <View style={styles.pickerContainer}>
                {roles.map((role) => (
                  <TouchableOpacity
                    key={role}
                    style={[
                      styles.pickerOption,
                      formData.role === role && styles.pickerOptionSelected
                    ]}
                    onPress={() => setFormData(prev => ({ ...prev, role }))}
                  >
                    <Text style={[
                      styles.pickerOptionText,
                      formData.role === role && styles.pickerOptionTextSelected
                    ]}>
                      {role.charAt(0).toUpperCase() + role.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <TouchableOpacity
              style={[styles.registerButton, loading && styles.registerButtonDisabled]}
              onPress={() => {
                console.log('Button pressed!');
                handleRegister();
              }}
              disabled={loading}
            >
              <Text style={styles.registerButtonText}>
                {loading ? 'Registering...' : 'Register Employee'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    padding: 8,
    backgroundColor: '#1e3a8a',
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 11,
    color: '#e5e7eb',
  },
  mainContent: {
    flex: 1,
  },
  form: {
    padding: 8,
  },
  inputGroup: {
    marginBottom: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 3,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: '#374151',
    backgroundColor: '#ffffff',
  },
  readOnlyInput: {
    backgroundColor: '#f3f4f6',
    color: '#6b7280',
  },
  helperText: {
    fontSize: 9,
    color: '#6b7280',
    marginTop: 1,
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  passwordInput: {
    flex: 1,
    marginRight: 6,
  },
  generateButton: {
    backgroundColor: '#6b7280',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 4,
  },
  generateButtonText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  pickerContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  pickerOption: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  pickerOptionSelected: {
    backgroundColor: '#1e3a8a',
    borderColor: '#1e3a8a',
  },
  pickerOptionText: {
    fontSize: 11,
    color: '#374151',
  },
  pickerOptionTextSelected: {
    color: '#ffffff',
  },
  registerButton: {
    backgroundColor: '#1e3a8a',
    borderRadius: 4,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
  registerButtonDisabled: {
    backgroundColor: '#9ca3af',
  },
  registerButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  formEndIndicator: {
    padding: 8,
    backgroundColor: '#f3f4f6',
    borderRadius: 4,
    marginTop: 8,
    alignItems: 'center',
  },
  formEndText: {
    fontSize: 10,
    color: '#6b7280',
    fontWeight: '600',
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#374151',
    marginBottom: 8,
  },
  organizationInfo: {
    marginBottom: 16,
    padding: 8,
    backgroundColor: '#f3f4f6',
    borderRadius: 4,
  },
  organizationText: {
    fontSize: 11,
    color: '#374151',
    fontWeight: '600',
  },
  organizationName: {
    fontSize: 11,
    color: '#1e3a8a',
    fontWeight: 'bold',
  },
});

export default EmployeeRegistrationScreen; 