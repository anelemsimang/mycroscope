import React, { createContext, useContext, useEffect, useState } from 'react';
import { User } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, Employee, getEmployeeByEmail, getEmployeeByEmployeeId } from '../utils/supabaseClient';

interface AuthContextType {
  user: User | null;
  employee: Employee | null;
  loading: boolean;
  signIn: (emailOrEmployeeId: string, password: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: React.ReactNode;
}

// Storage keys for session management
const SESSION_STORAGE_KEY = 'mycroscope_user_session';
const EMPLOYEE_STORAGE_KEY = 'mycroscope_employee_data';

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [loading, setLoading] = useState(true);

  // Session refresh interval
  const sessionRefreshIntervalRef = React.useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Check if we have a stored session on app startup
    const checkStoredSession = async () => {
      try {
        console.log('🔍 Checking for stored session...');
        
        // Get stored session data
        const storedSession = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
        const storedEmployee = await AsyncStorage.getItem(EMPLOYEE_STORAGE_KEY);
        
        if (storedSession && storedEmployee) {
          console.log('📱 Found stored session, attempting to restore...');
          
          const sessionData = JSON.parse(storedSession);
          const employeeData = JSON.parse(storedEmployee);
          
          // Check if session is still valid (not expired)
          const sessionExpiry = new Date(sessionData.expiresAt);
          const now = new Date();
          
          if (sessionExpiry > now) {
            console.log('✅ Session is still valid, restoring...');
            
            // Verify employee still exists and is active
            try {
              const currentEmployee = await getEmployeeByEmployeeId(employeeData.employee_id, employeeData.organization_id);
              
              if (currentEmployee && currentEmployee.is_active) {
                console.log('✅ Employee verified, restoring session');
                setUser(sessionData.user);
                setEmployee(currentEmployee);
                
                // Start session refresh mechanism
                startSessionRefresh();
              } else {
                console.log('❌ Employee no longer exists or is inactive, clearing session');
                await clearStoredSession();
              }
            } catch (error) {
              console.log('❌ Error verifying employee, clearing session:', error);
              await clearStoredSession();
            }
          } else {
            console.log('❌ Session expired, clearing stored data');
            await clearStoredSession();
          }
        } else {
          console.log('📱 No stored session found');
        }
      } catch (error) {
        console.error('❌ Error checking stored session:', error);
        await clearStoredSession();
      } finally {
        setLoading(false);
      }
    };

    checkStoredSession();

    // Cleanup on unmount
    return () => {
      if (sessionRefreshIntervalRef.current) {
        clearInterval(sessionRefreshIntervalRef.current);
      }
    };
  }, []);

  // Start session refresh mechanism
  const startSessionRefresh = () => {
    // Clear any existing interval
    if (sessionRefreshIntervalRef.current) {
      clearInterval(sessionRefreshIntervalRef.current);
    }

    // Check session every hour and refresh if needed
    sessionRefreshIntervalRef.current = setInterval(async () => {
      try {
        const storedSession = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
        if (storedSession) {
          const sessionData = JSON.parse(storedSession);
          const sessionExpiry = new Date(sessionData.expiresAt);
          const now = new Date();
          
          // If session expires in less than 7 days, refresh it
          const sevenDaysFromNow = new Date();
          sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
          
          if (sessionExpiry < sevenDaysFromNow && employee) {
            console.log('🔄 Refreshing session...');
            await storeSession(sessionData.user, employee);
          }
        }
      } catch (error) {
        console.error('Error refreshing session:', error);
      }
    }, 60 * 60 * 1000); // Check every hour
  };

  // Helper function to clear stored session
  const clearStoredSession = async () => {
    try {
      await AsyncStorage.multiRemove([SESSION_STORAGE_KEY, EMPLOYEE_STORAGE_KEY]);
      console.log('🧹 Cleared stored session data');
      
      // Stop session refresh
      if (sessionRefreshIntervalRef.current) {
        clearInterval(sessionRefreshIntervalRef.current);
        sessionRefreshIntervalRef.current = null;
      }
    } catch (error) {
      console.error('Error clearing stored session:', error);
    }
  };

  // Helper function to store session data
  const storeSession = async (userData: User, employeeData: Employee) => {
    try {
      // Create session data with expiry (30 days from now)
      const sessionExpiry = new Date();
      sessionExpiry.setDate(sessionExpiry.getDate() + 30);
      
      const sessionData = {
        user: userData,
        expiresAt: sessionExpiry.toISOString(),
        createdAt: new Date().toISOString()
      };
      
      // Store session and employee data
      await AsyncStorage.multiSet([
        [SESSION_STORAGE_KEY, JSON.stringify(sessionData)],
        [EMPLOYEE_STORAGE_KEY, JSON.stringify(employeeData)]
      ]);
      
      console.log('💾 Session stored successfully, expires:', sessionExpiry.toLocaleDateString());
    } catch (error) {
      console.error('Error storing session:', error);
    }
  };

  const signIn = async (emailOrEmployeeId: string, password: string) => {
    try {
      console.log('🔐 Attempting to sign in with:', emailOrEmployeeId);
      
      // Try email first
      let employee = await getEmployeeByEmail(emailOrEmployeeId);
      
      // If email fails, try employee_id
      if (!employee) {
        employee = await getEmployeeByEmployeeId(emailOrEmployeeId);
      }
      
      if (!employee) {
        console.log('❌ No employee found with email or employee_id:', emailOrEmployeeId);
        return { error: { message: 'Invalid credentials' } };
      }
      
      // Check password (in production, use proper hashing)
      if (employee.password_hash !== password) {
        console.log('❌ Password mismatch for employee:', employee.name);
        return { error: { message: 'Invalid credentials' } };
      }
      
      // Check if employee is active
      if (!employee.is_active) {
        console.log('❌ Employee account is inactive:', employee.name);
        return { error: { message: 'Account is inactive. Please contact your administrator.' } };
      }
      
      // Create a mock user object for consistency
      const mockUser: User = {
        id: employee.id,
        email: employee.email,
        created_at: employee.created_at,
        updated_at: employee.updated_at,
        aud: 'authenticated',
        role: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        identities: [],
        factors: [],
      };
      
      // Store session data
      await storeSession(mockUser, employee);
      
      // Set the user and employee
      setUser(mockUser);
      setEmployee(employee);
      
      // Start session refresh mechanism
      startSessionRefresh();
      
      console.log('✅ Successfully signed in:', employee.name, 'Organization:', employee.organization_id);
      return { error: null };
      
    } catch (error) {
      console.error('❌ Sign in error:', error);
      return { error: { message: 'An unexpected error occurred' } };
    }
  };

  const signOut = async () => {
    try {
      console.log('🚪 === SIGNOUT CALLED ===');
      console.log('Before signOut - user:', user);
      console.log('Before signOut - employee:', employee);
      
      // Clear stored session
      await clearStoredSession();
      
      // Clear state
      setUser(null);
      setEmployee(null);
      
      console.log('✅ After signOut - user and employee set to null, session cleared');
    } catch (error) {
      console.error('❌ Error signing out:', error);
    }
  };

  const value = {
    user,
    employee,
    loading,
    signIn,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}; 