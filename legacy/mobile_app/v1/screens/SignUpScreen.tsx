import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { supabase } from '../utils/supabaseClient';
import { useAuth } from '../context/AuthContext';

const SignUpScreen: React.FC = () => {
  const [formData, setFormData] = useState({
    organizationName: '',
    secretKey: '',
    ownerName: '',
    email: '',
    password: '',
    confirmPassword: '',
    phone: '',
  });
  const [loading, setLoading] = useState(false);
  const [organizationVerified, setOrganizationVerified] = useState(false);
  const [verifiedOrganization, setVerifiedOrganization] = useState<any>(null);
  const { signIn } = useAuth();

  useEffect(() => {
    console.log('SignUpScreen loaded');
    Alert.alert('Debug', 'SignUpScreen is loaded!');
  }, []);

  const verifyOrganization = async () => {
    if (!formData.organizationName || !formData.secretKey) {
      Alert.alert('Error', 'Please enter both organization name and secret key');
      return;
    }

    setLoading(true);
    try {
      // Verify organization and secret key
      const { data: org, error } = await supabase
        .from('organizations')
        .select('*')
        .eq('name', formData.organizationName.trim())
        .eq('secret_key', formData.secretKey.trim())
        .single();

      if (error || !org) {
        Alert.alert('Error', 'Invalid organization name or secret key. Please check your credentials from the admin dashboard.');
        return;
      }

      if (org.subscription_status !== 'active') {
        Alert.alert('Error', 'Organization is not active. Please contact the administrator.');
        return;
      }

      setVerifiedOrganization(org);
      setOrganizationVerified(true);
      
      Alert.alert('Success', `Organization verified: ${org.name}\nYou can now complete your registration.`);

    } catch (error) {
      Alert.alert('Error', 'Failed to verify organization');
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    if (!organizationVerified || !verifiedOrganization) {
      Alert.alert('Error', 'Please verify your organization first');
      return;
    }

    if (!formData.ownerName || !formData.email || !formData.password || !formData.confirmPassword) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }

    if (formData.password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters long');
      return;
    }

    setLoading(true);
    
    try {
      console.log('=== STARTING ACCOUNT CREATION ===');
      console.log('Organization ID:', verifiedOrganization.id);
      console.log('Owner Name:', formData.ownerName);
      console.log('Email:', formData.email);
      
      // First, check if user already exists
      const { data: existingUser, error: checkError } = await supabase
        .from('employees')
        .select('*')
        .eq('email', formData.email)
        .eq('organization_id', verifiedOrganization.id)
        .single();

      if (existingUser && !checkError) {
        console.log('User already exists, attempting to sign in...');
        // User already exists, try to sign them in
        const { error: signInError } = await signIn(formData.email, formData.password);
        if (signInError) {
          Alert.alert('Account Exists', 'An account with this email already exists, but the password is incorrect. Please use the correct password or contact support.');
        } else {
          Alert.alert('Welcome Back!', 'You are now signed in to your existing account.');
        }
        return;
      }
      
      // Create the organization owner account
      const { data: owner, error: ownerError } = await supabase
        .from('employees')
        .insert([{
          employee_id: `OWNER_${Date.now()}`,
          name: formData.ownerName,
          email: formData.email,
          password_hash: formData.password,
          role: 'admin',
          department: 'Management',
          organization_id: verifiedOrganization.id,
          is_active: true
        }])
        .select()
        .single();

      if (ownerError) {
        console.error('=== DATABASE ERROR ===');
        console.error('Error code:', ownerError.code);
        console.error('Error message:', ownerError.message);
        console.error('Error details:', ownerError.details);
        Alert.alert('Error', `Failed to create account: ${ownerError.message}`);
        return;
      }

      console.log('Owner created successfully:', owner);

      // Update organization with owner contact info
      const { error: updateError } = await supabase
        .from('organizations')
        .update({
          contact_person: formData.ownerName,
          phone: formData.phone
        })
        .eq('id', verifiedOrganization.id);

      if (updateError) {
        console.error('Error updating organization:', updateError);
      }

      Alert.alert(
        'Registration Successful!',
        `Welcome to ${verifiedOrganization.name}!\n\nYou can now sign in with your email and password.`,
        [
          {
            text: 'Sign In Now',
            onPress: async () => {
              // Auto sign in the user
              const { error } = await signIn(formData.email, formData.password);
              if (error) {
                Alert.alert('Auto Sign In Failed', 'Please sign in manually');
              }
            }
          }
        ]
      );

    } catch (error) {
      console.error('Signup error:', error);
      Alert.alert('Error', `Failed to create account: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 150 : 50}
    >
      <ScrollView 
        contentContainerStyle={styles.scrollContainer}
        showsVerticalScrollIndicator={true}
        keyboardShouldPersistTaps="handled"
        bounces={false}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.logoContainer}>
          <Text style={styles.logo}>Mycroscope</Text>
          <Text style={styles.subtitle}>Organization Registration</Text>
        </View>

        <View style={styles.formContainer}>
          {/* Organization Verification Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Organization Verification</Text>
            
            <View style={styles.inputContainer}>
              <Text style={styles.label}>Organization Name *</Text>
              <TextInput
                style={styles.input}
                value={formData.organizationName}
                onChangeText={(text) => setFormData(prev => ({ ...prev, organizationName: text }))}
                placeholder="Enter organization name from admin dashboard"
                placeholderTextColor="#6b7280"
                editable={!organizationVerified}
              />
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Secret Key *</Text>
              <TextInput
                style={styles.input}
                value={formData.secretKey}
                onChangeText={(text) => setFormData(prev => ({ ...prev, secretKey: text }))}
                placeholder="Enter secret key from admin dashboard"
                placeholderTextColor="#6b7280"
                secureTextEntry
                editable={!organizationVerified}
              />
              <Text style={styles.helperText}>
                Get these credentials from your admin dashboard
              </Text>
            </View>

            {!organizationVerified ? (
              <TouchableOpacity
                style={[styles.verifyButton, loading && styles.buttonDisabled]}
                onPress={verifyOrganization}
                disabled={loading}
              >
                <Text style={styles.verifyButtonText}>
                  {loading ? 'Verifying...' : 'Verify Organization'}
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.verifiedSection}>
                <Text style={styles.verifiedText}>✅ Organization Verified: {verifiedOrganization?.name}</Text>
                <TouchableOpacity
                  style={styles.changeButton}
                  onPress={() => {
                    setOrganizationVerified(false);
                    setVerifiedOrganization(null);
                    setFormData(prev => ({ ...prev, organizationName: '', secretKey: '' }));
                  }}
                >
                  <Text style={styles.changeButtonText}>Change Organization</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Owner Registration Section */}
          {organizationVerified && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Owner Account Details</Text>
              
              <View style={styles.inputContainer}>
                <Text style={styles.label}>Full Name *</Text>
                <TextInput
                  style={styles.input}
                  value={formData.ownerName}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, ownerName: text }))}
                  placeholder="Enter your full name"
                  placeholderTextColor="#6b7280"
                />
              </View>

              <View style={styles.inputContainer}>
                <Text style={styles.label}>Email *</Text>
                <TextInput
                  style={styles.input}
                  value={formData.email}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, email: text }))}
                  placeholder="your.email@company.com"
                  placeholderTextColor="#6b7280"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <View style={styles.inputContainer}>
                <Text style={styles.label}>Password *</Text>
                <TextInput
                  style={styles.input}
                  value={formData.password}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, password: text }))}
                  placeholder="Create a password"
                  placeholderTextColor="#6b7280"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <View style={styles.inputContainer}>
                <Text style={styles.label}>Confirm Password *</Text>
                <TextInput
                  style={styles.input}
                  value={formData.confirmPassword}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, confirmPassword: text }))}
                  placeholder="Confirm your password"
                  placeholderTextColor="#6b7280"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <View style={styles.inputContainer}>
                <Text style={styles.label}>Phone (Optional)</Text>
                <TextInput
                  style={styles.input}
                  value={formData.phone}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, phone: text }))}
                  placeholder="+1 (555) 123-4567"
                  placeholderTextColor="#6b7280"
                  keyboardType="phone-pad"
                />
              </View>

              <TouchableOpacity
                style={[styles.signUpButton, loading && styles.buttonDisabled]}
                onPress={handleSignUp}
                disabled={loading}
                activeOpacity={0.7}
              >
                <Text style={styles.signUpButtonText}>
                  {loading ? 'Creating Account...' : 'Create Account'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Secure organization registration with admin verification
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  scrollContainer: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 5,
    paddingBottom: 50,
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 10,
  },
  logo: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1e3a8a',
    marginBottom: 1,
  },
  subtitle: {
    fontSize: 10,
    color: '#6b7280',
    textAlign: 'center',
  },
  formContainer: {
    marginBottom: 8,
  },
  section: {
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#1f2937',
    marginBottom: 6,
  },
  inputContainer: {
    marginBottom: 6,
  },
  label: {
    fontSize: 9,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 2,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 11,
    color: '#1f2937',
    backgroundColor: '#ffffff',
  },
  helperText: {
    fontSize: 8,
    color: '#6b7280',
    marginTop: 1,
  },
  verifyButton: {
    backgroundColor: '#1e3a8a',
    borderRadius: 6,
    paddingVertical: 6,
    alignItems: 'center',
    marginTop: 3,
  },
  verifyButtonText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  verifiedSection: {
    padding: 6,
    backgroundColor: '#f0f9ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    alignItems: 'center',
    marginTop: 3,
  },
  verifiedText: {
    fontSize: 9,
    color: '#0c4a6e',
    fontWeight: '600',
    marginBottom: 3,
  },
  changeButton: {
    backgroundColor: '#6b7280',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  changeButtonText: {
    color: '#ffffff',
    fontSize: 8,
    fontWeight: '600',
  },
  signUpButton: {
    backgroundColor: '#059669',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 10,
    minHeight: 44,
  },
  signUpButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    backgroundColor: '#9ca3af',
  },
  footer: {
    alignItems: 'center',
    marginTop: 4,
  },
  footerText: {
    fontSize: 8,
    color: '#6b7280',
    textAlign: 'center',
  },
});

export default SignUpScreen; 