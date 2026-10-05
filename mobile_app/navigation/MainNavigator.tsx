import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { useAuth } from '../context/AuthContext';
import LoginScreen from '../screens/LoginScreen';
import SignUpScreen from '../screens/SignUpScreen';
import DashboardScreen from '../screens/DashboardScreen';
import ReportScreen from '../screens/ReportScreen';
import EmployeeDetailScreen from '../screens/EmployeeDetailScreen';
import EmployeeRegistrationScreen from '../screens/EmployeeRegistrationScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AppDetailScreen from '../screens/AppDetailScreen';
import WebDetailScreen from '../screens/WebDetailScreen';
import DailyDetailScreen from '../screens/DailyDetailScreen';
import ProjectSelectionScreen from '../screens/ProjectSelectionScreen';

export type RootStackParamList = {
  Login: undefined;
  SignUp: undefined;
  Dashboard: undefined;
  Report: undefined;
  EmployeeDetail: { employeeId: string; projectFilter?: string };
  EmployeeRegistration: undefined;
  Settings: undefined;
  AppDetail: { appName: string; appData: any[]; employeeId: string };
  WebDetail: { domain: string; webData: any[]; employeeId: string };
  DailyDetail: { date: string; employeeId: string };
  ProjectSelection: { employeeId: string };
};

const Stack = createStackNavigator<RootStackParamList>();

const MainNavigator: React.FC = () => {
  const { user, employee, loading } = useAuth();

  console.log('=== MAIN NAVIGATOR RENDER ===');
  console.log('User state:', user);
  console.log('Employee state:', employee);
  console.log('Loading state:', loading);
  console.log('Should show auth screens:', !user);

  if (loading) {
    // You can add a loading screen here
    return null;
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: {
            backgroundColor: '#1e3a8a', // Navy
          },
          headerTintColor: '#ffffff',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
        }}
      >
        {!user ? (
          // Auth screens
          <>
            <Stack.Screen
              name="Login"
              component={LoginScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="SignUp"
              component={SignUpScreen}
              options={{ 
                headerShown: true,
                title: 'Organization Registration',
                headerBackTitle: 'Back to Login'
              }}
            />
          </>
        ) : (
          // Main app screens
          <>
            <Stack.Screen
              name="Dashboard"
              component={DashboardScreen}
              options={{
                title: 'Mycroscope Dashboard',
                headerRight: () => null, // You can add a logout button here
              }}
            />
            <Stack.Screen
              name="Report"
              component={ReportScreen}
              options={{
                title: 'Professional Report',
              }}
            />
            <Stack.Screen
              name="EmployeeDetail"
              component={EmployeeDetailScreen}
              options={{
                title: 'Employee Details',
              }}
            />
            <Stack.Screen
              name="EmployeeRegistration"
              component={EmployeeRegistrationScreen}
              options={{
                title: 'Employee Registration',
              }}
            />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{
                title: 'Settings',
              }}
            />
            <Stack.Screen
              name="AppDetail"
              component={AppDetailScreen}
              options={{
                title: 'App Details',
              }}
            />
            <Stack.Screen
              name="WebDetail"
              component={WebDetailScreen}
              options={{
                title: 'Website Details',
              }}
            />
            <Stack.Screen
              name="DailyDetail"
              component={DailyDetailScreen}
              options={{
                title: 'Daily Details',
              }}
            />
            <Stack.Screen
              name="ProjectSelection"
              component={ProjectSelectionScreen}
              options={{
                title: 'Project Selection',
              }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
};

export default MainNavigator; 