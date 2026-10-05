import { createClient } from '@supabase/supabase-js';

// Supabase configuration
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

// Create Supabase client
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Database types
export interface Employee {
  id: string;
  organization_id: string;
  employee_id: string;
  name: string;
  email: string;
  password_hash: string;
  department: string;
  role: 'employee' | 'manager' | 'admin';
  position?: string;
  hire_date?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ActivityLog {
  id: string;
  employee_id: string;
  organization_id: string;
  session_id?: string;
  activity_type: string;
  description?: string;
  timestamp: string;
  metadata?: any;
  created_at: string;
}

export interface Session {
  id: string;
  employee_id: string;
  organization_id: string;
  session_token: string;
  login_time: string;
  logout_time?: string;
  is_active: boolean;
  ip_address?: string;
  user_agent?: string;
  created_at: string;
}

export interface AppUsage {
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
  current_project?: string;
  created_at: string;
}

export interface WebActivity {
  id: string;
  employee_id: string;
  organization_id: string;
  session_id?: string;
  url: string;
  title?: string;
  domain?: string;
  start_time: string;
  end_time?: string;
  duration_seconds?: number;
  is_active: boolean;
  current_project?: string;
  created_at: string;
}

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  description?: string;
  created_by: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Authentication functions - Support both email and employee_id
export const signIn = async (emailOrEmployeeId: string, password: string) => {
  // Try email first, then employee_id
  let { data, error } = await supabase.auth.signInWithPassword({
    email: emailOrEmployeeId,
    password,
  });
  
  if (error) {
    // If email fails, try employee_id
    const { data: employee } = await supabase
      .from('employees')
      .select('*')
      .eq('employee_id', emailOrEmployeeId)
      .single();
    
    if (employee && employee.password_hash === password) {
      // Create a mock user for consistency
      const mockUser = {
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
      return { data: { user: mockUser }, error: null };
    }
  }
  
  return { data, error };
};

export const signOut = async () => {
  const { error } = await supabase.auth.signOut();
  return { error };
};

export const getCurrentUser = async () => {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
};

// Employee functions with organization filtering
export const getEmployeeByEmail = async (email: string, organizationId?: string): Promise<Employee | null> => {
  let query = supabase
    .from('employees')
    .select('*')
    .eq('email', email);
  
  if (organizationId) {
    query = query.eq('organization_id', organizationId);
  }
  
  const { data, error } = await query.single();
  
  if (error) {
    console.error('Error fetching employee:', error);
    return null;
  }
  
  return data;
};

export const getEmployeeByEmployeeId = async (employeeId: string, organizationId?: string): Promise<Employee | null> => {
  let query = supabase
    .from('employees')
    .select('*')
    .eq('employee_id', employeeId);
  
  if (organizationId) {
    query = query.eq('organization_id', organizationId);
  }
  
  const { data, error } = await query.single();
  
  if (error) {
    console.error('Error fetching employee:', error);
    return null;
  }
  
  return data;
};

export const getAllEmployees = async (organizationId?: string): Promise<Employee[]> => {
  let query = supabase
    .from('employees')
    .select('*')
    .order('name');
  
  if (organizationId) {
    query = query.eq('organization_id', organizationId);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error('Error fetching employees:', error);
    return [];
  }
  
  return data || [];
};

// Delete employee and all associated data
export const deleteEmployee = async (employeeId: string, organizationId: string): Promise<{ success: boolean; error?: string }> => {
  try {
    console.log('🗑️ Starting employee deletion for:', employeeId, 'in organization:', organizationId);
    
    // First, get the employee to verify they exist and get their UUID
    const { data: employee, error: fetchError } = await supabase
      .from('employees')
      .select('id, name, employee_id')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .single();
    
    if (fetchError || !employee) {
      console.error('❌ Employee not found:', fetchError);
      return { success: false, error: 'Employee not found' };
    }
    
    const employeeUuid = employee.id;
    console.log('🗑️ Found employee UUID:', employeeUuid);
    
    // Delete all associated data in the correct order (respecting foreign key constraints)
    const deletionSteps = [
      // 1. Delete web activity
      () => supabase.from('web_activity').delete().eq('employee_id', employeeUuid).eq('organization_id', organizationId),
      
      // 2. Delete app usage
      () => supabase.from('app_usage').delete().eq('employee_id', employeeUuid).eq('organization_id', organizationId),
      
      // 3. Delete activity logs
      () => supabase.from('activity_logs').delete().eq('employee_id', employeeUuid).eq('organization_id', organizationId),
      
      // 4. Delete sessions
      () => supabase.from('sessions').delete().eq('employee_id', employeeUuid).eq('organization_id', organizationId),
      
      // 5. Delete project assignments (if table exists)
      () => supabase.from('project_assignments').delete().eq('employee_id', employeeUuid).eq('organization_id', organizationId),
      
      // 6. Finally, delete the employee
      () => supabase.from('employees').delete().eq('id', employeeUuid).eq('organization_id', organizationId),
    ];
    
    // Execute deletion steps
    for (let i = 0; i < deletionSteps.length; i++) {
      const step = deletionSteps[i];
      const { error } = await step();
      
      if (error) {
        // Log the error but continue (some tables might not exist or have no data)
        console.log(`⚠️ Step ${i + 1} deletion warning:`, error.message);
        // Only fail if it's the employee deletion step
        if (i === deletionSteps.length - 1) {
          console.error('❌ Failed to delete employee:', error);
          return { success: false, error: `Failed to delete employee: ${error.message}` };
        }
      } else {
        console.log(`✅ Step ${i + 1} completed successfully`);
      }
    }
    
    console.log('✅ Employee deletion completed successfully');
    return { success: true };
    
  } catch (error) {
    console.error('❌ Error during employee deletion:', error);
    return { success: false, error: `Unexpected error: ${error}` };
  }
};

// Activity functions with organization filtering
export const getActivityLogs = async (
  organizationId?: string,
  employeeId?: string,
  startDate?: string,
  endDate?: string
): Promise<ActivityLog[]> => {
  try {
    let query = supabase.from('activity_logs').select('*');
    if (organizationId) query = query.eq('organization_id', organizationId);
    if (employeeId) query = query.eq('employee_id', employeeId);
    if (startDate) query = query.gte('timestamp', startDate);
    if (endDate) query = query.lte('timestamp', endDate);
    const { data, error } = await query;
    if (error) {
      console.error('❌ Error fetching activity logs:', error);
      return [];
    }
    console.log('📦 Raw activity_logs data:', data);
    return data || [];
  } catch (error) {
    console.error('❌ Error fetching activity logs:', error);
    return [];
  }
};

export const getActiveSessions = async (organizationId?: string): Promise<Session[]> => {
  // Get sessions from the last 24 hours that are marked as active
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
  let query = supabase
    .from('sessions')
    .select('*')
    .eq('is_active', true)
    .gte('login_time', twentyFourHoursAgo)
    .order('login_time', { ascending: false });
  
  if (organizationId) {
    query = query.eq('organization_id', organizationId);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error('❌ Error fetching active sessions:', error);
    return [];
  }
  
  // Additional validation: check if sessions are actually recent (within last 15 minutes)
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const trulyActiveSessions = data?.filter(session => {
    const loginTime = new Date(session.login_time);
    const isRecent = loginTime > fifteenMinutesAgo;
    
    if (!isRecent) {
      console.log(`⚠️ Session ${session.id} is too old (${session.login_time}), marking as inactive`);
      // In a real app, you'd update the session to inactive here
    }
    
    return isRecent;
  }) || [];
  
  return trulyActiveSessions;
};

// Mark old sessions as inactive
export const cleanupOldSessions = async (organizationId?: string): Promise<{ success: boolean; count?: number; error?: any }> => {
  console.log('🧹 Cleaning up old sessions...');
  
  try {
    // Mark sessions older than 15 minutes as inactive
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    
    let query = supabase
      .from('sessions')
      .update({ 
        is_active: false,
        logout_time: new Date().toISOString()
      })
      .eq('is_active', true)
      .lt('login_time', fifteenMinutesAgo);
    
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }
    
    const { error } = await query;
    
    if (error) {
      console.error('❌ Error cleaning up old sessions:', error);
      return { success: false, error };
    }
    
    console.log('✅ Cleaned up old sessions successfully');
    return { success: true, count: 0 };
  } catch (error) {
    console.error('❌ Error in cleanupOldSessions:', error);
    return { success: false, error };
  }
};

export const getAppUsage = async (
  organizationId?: string,
  employeeId?: string,
  startDate?: string,
  endDate?: string
): Promise<AppUsage[]> => {
  try {
    let query = supabase.from('app_usage').select('*');
    if (organizationId) query = query.eq('organization_id', organizationId);
    if (employeeId) query = query.eq('employee_id', employeeId);
    if (startDate) query = query.gte('start_time', startDate);
    if (endDate) query = query.lte('end_time', endDate);
    const { data, error } = await query;
    if (error) {
      console.error('❌ Error fetching app usage:', error);
      return [];
    }
    console.log('📦 Raw app_usage data:', data);
    return data || [];
  } catch (error) {
    console.error('❌ Error fetching app usage:', error);
    return [];
  }
};

export const getWebActivity = async (
  organizationId?: string,
  employeeId?: string,
  startDate?: string,
  endDate?: string
): Promise<WebActivity[]> => {
  try {
    let query = supabase.from('web_activity').select('*');
    if (organizationId) query = query.eq('organization_id', organizationId);
    if (employeeId) query = query.eq('employee_id', employeeId);
    if (startDate) query = query.gte('start_time', startDate);
    if (endDate) query = query.lte('end_time', endDate);
    const { data, error } = await query;
    if (error) {
      console.error('❌ Error fetching web activity:', error);
      return [];
    }
    console.log('📦 Raw web_activity data:', data);
    return data || [];
  } catch (error) {
    console.error('❌ Error fetching web activity:', error);
    return [];
  }
};

// Real-time subscriptions
export const subscribeToActivityLogs = (callback: (payload: any) => void, organizationId?: string) => {
  const channelName = `activity_logs_${organizationId || 'all'}_${Date.now()}`;
  return supabase
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_logs' }, (payload) => {
      // Filter by organization_id in the callback if provided
      if (organizationId && payload.new && typeof payload.new === 'object' && 'organization_id' in payload.new && payload.new.organization_id !== organizationId) {
        return;
      }
      callback(payload);
    })
    .subscribe();
};

export const subscribeToSessions = (callback: (payload: any) => void, organizationId?: string) => {
  const channelName = `sessions_${organizationId || 'all'}_${Date.now()}`;
  return supabase
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, (payload) => {
      // Filter by organization_id in the callback if provided
      if (organizationId && payload.new && typeof payload.new === 'object' && 'organization_id' in payload.new && payload.new.organization_id !== organizationId) {
        return;
      }
      callback(payload);
    })
    .subscribe();
};

export const subscribeToAppUsage = (callback: (payload: any) => void, organizationId?: string) => {
  const channelName = `app_usage_${organizationId || 'all'}_${Date.now()}`;
  return supabase
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_usage' }, (payload) => {
      // Filter by organization_id in the callback if provided
      if (organizationId && payload.new && typeof payload.new === 'object' && 'organization_id' in payload.new && payload.new.organization_id !== organizationId) {
        return;
      }
      callback(payload);
    })
    .subscribe();
};

export const subscribeToWebActivity = (callback: (payload: any) => void, organizationId?: string) => {
  const channelName = `web_activity_${organizationId || 'all'}_${Date.now()}`;
  return supabase
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'web_activity' }, (payload) => {
      // Filter by organization_id in the callback if provided
      if (organizationId && payload.new && typeof payload.new === 'object' && 'organization_id' in payload.new && payload.new.organization_id !== organizationId) {
        return;
      }
      callback(payload);
    })
    .subscribe();
};

// Report generation functions
export const generateEmployeeReport = async (
  employeeId: string,
  organizationId: string,
  startDate: string,
  endDate: string
) => {
  try {
    const [activityLogs, appUsage, webActivity, sessions] = await Promise.all([
      getActivityLogs(organizationId, employeeId, startDate, endDate),
      getAppUsage(organizationId, employeeId, startDate, endDate),
      getWebActivity(organizationId, employeeId, startDate, endDate),
      getEmployeeSessions(employeeId, organizationId, startDate, endDate)
    ]);

    return {
      employeeId,
      organizationId,
      period: { startDate, endDate },
      summary: {
        totalActivities: activityLogs.length,
        totalAppTime: appUsage.reduce((sum, app) => sum + (app.duration_seconds || 0), 0),
        totalWebTime: webActivity.reduce((sum, web) => sum + (web.duration_seconds || 0), 0),
        totalSessions: sessions.length,
        averageSessionDuration: sessions.length > 0 ? 
          sessions.reduce((sum, session) => {
            const start = new Date(session.login_time);
            const end = session.logout_time ? new Date(session.logout_time) : new Date();
            return sum + (end.getTime() - start.getTime()) / 1000 / 60; // minutes
          }, 0) / sessions.length : 0
      },
      details: {
        activityLogs,
        appUsage,
        webActivity,
        sessions
      }
    };
  } catch (error) {
    console.error('Error generating employee report:', error);
    return null;
  }
};

export const generateDepartmentReport = async (
  department: string,
  organizationId: string,
  startDate: string,
  endDate: string
) => {
  try {
    // Get all employees in the department
    const { data: employees } = await supabase
      .from('employees')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('department', department);

    if (!employees || employees.length === 0) {
      return null;
    }

    // Get data for all employees in the department
    const employeeIds = employees.map(emp => emp.id);
    const [activityLogs, appUsage, webActivity, sessions] = await Promise.all([
      getActivityLogs(organizationId, undefined, startDate, endDate),
      getAppUsage(organizationId, undefined, startDate, endDate),
      getWebActivity(organizationId, undefined, startDate, endDate),
      getActiveSessions(organizationId)
    ]);

    // Filter data for department employees
    const departmentActivityLogs = activityLogs.filter(log => employeeIds.includes(log.employee_id));
    const departmentAppUsage = appUsage.filter(app => employeeIds.includes(app.employee_id));
    const departmentWebActivity = webActivity.filter(web => employeeIds.includes(web.employee_id));
    const departmentSessions = sessions.filter(session => employeeIds.includes(session.employee_id));

    return {
      department,
      organizationId,
      period: { startDate, endDate },
      summary: {
        totalEmployees: employees.length,
        totalActivities: departmentActivityLogs.length,
        totalAppTime: departmentAppUsage.reduce((sum, app) => sum + (app.duration_seconds || 0), 0),
        totalWebTime: departmentWebActivity.reduce((sum, web) => sum + (web.duration_seconds || 0), 0),
        totalSessions: departmentSessions.length,
        averageSessionDuration: departmentSessions.length > 0 ? 
          departmentSessions.reduce((sum, session) => {
            const start = new Date(session.login_time);
            const end = session.logout_time ? new Date(session.logout_time) : new Date();
            return sum + (end.getTime() - start.getTime()) / 1000 / 60; // minutes
          }, 0) / departmentSessions.length : 0
      },
      details: {
        employees,
        activityLogs: departmentActivityLogs,
        appUsage: departmentAppUsage,
        webActivity: departmentWebActivity,
        sessions: departmentSessions
      }
    };
  } catch (error) {
    console.error('Error generating department report:', error);
    return null;
  }
};

export const getAnalyticsData = async (organizationId: string, period: string = 'week', employeeId?: string) => {
  try {
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
        startDate.setDate(now.getDate() - 7);
    }

    const [employees, sessions, activityLogs, appUsage, webActivity] = await Promise.all([
      getAllEmployees(organizationId),
      getActiveSessions(organizationId),
      getActivityLogs(organizationId, employeeId, startDate.toISOString(), now.toISOString()),
      getAppUsage(organizationId, employeeId, startDate.toISOString(), now.toISOString()),
      getWebActivity(organizationId, employeeId, startDate.toISOString(), now.toISOString())
    ]);

    // Calculate real-time metrics
    const onlineEmployees = sessions.length;
    const totalEmployees = employees.length;
    const onlineRate = totalEmployees > 0 ? Math.round((onlineEmployees / totalEmployees) * 100) : 0;

    // Activity trends
    const activityByHour = new Array(24).fill(0);
    activityLogs.forEach(log => {
      const hour = new Date(log.timestamp).getHours();
      activityByHour[hour]++;
    });

    // App usage breakdown
    const appUsageBreakdown = appUsage.reduce((acc, app) => {
      acc[app.app_name] = (acc[app.app_name] || 0) + (app.duration_seconds || 0);
      return acc;
    }, {} as Record<string, number>);

    const topApps = Object.entries(appUsageBreakdown)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([app, duration]) => ({ app, duration }));

    // Web activity breakdown
    const webUsageBreakdown = webActivity.reduce((acc, web) => {
      let domain = web.domain || 'Unknown';
      if (!web.domain && web.url) {
        // Only try to parse URL if it looks like a valid URL
        if (web.url.includes('://') || web.url.startsWith('http')) {
          try {
            const url = new URL(web.url);
            domain = url.hostname;
          } catch (error) {
            // If URL parsing fails, use the URL as domain or a fallback
            domain = web.url.includes('.') ? web.url.split('/')[0] : 'Unknown';
          }
        } else {
          // For non-URL strings like "Google Chrome", use as domain
          domain = web.url;
        }
      }
      acc[domain] = (acc[domain] || 0) + (web.duration_seconds || 0);
      return acc;
    }, {} as Record<string, number>);

    const topWebsites = Object.entries(webUsageBreakdown)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([domain, duration]) => ({ domain, duration }));

    // Debug logging
    console.log('🔍 getAnalyticsData processing:', {
      activityLogsCount: activityLogs.length,
      appUsageCount: appUsage.length,
      webActivityCount: webActivity.length,
      sampleAppUsage: appUsage.slice(0, 3).map(app => ({ app: app.app_name, duration: app.duration_seconds })),
      sampleWebActivity: webActivity.slice(0, 3).map(web => ({ url: web.url, duration: web.duration_seconds })),
      totalAppTime: appUsage.reduce((sum, app) => sum + (app.duration_seconds || 0), 0),
      totalWebTime: webActivity.reduce((sum, web) => sum + (web.duration_seconds || 0), 0),
      topAppsCount: topApps.length,
      topWebsitesCount: topWebsites.length
    });

    return {
      period,
      summary: {
        totalEmployees,
        onlineEmployees,
        onlineRate,
        totalActivities: activityLogs.length,
        totalAppTime: appUsage.reduce((sum, app) => sum + (app.duration_seconds || 0), 0),
        totalWebTime: webActivity.reduce((sum, web) => sum + (web.duration_seconds || 0), 0)
      },
      trends: {
        activityByHour,
        topApps,
        topWebsites
      },
      realtime: {
        lastUpdated: new Date().toISOString(),
        activeSessions: sessions.length
      }
    };
  } catch (error) {
    console.error('Error fetching analytics data:', error);
    return null;
  }
};

// Enhanced session tracking
export const getEmployeeSessions = async (
  employeeId: string,
  organizationId: string,
  startDate?: string,
  endDate?: string
): Promise<Session[]> => {
  let query = supabase
    .from('sessions')
    .select('*')
    .eq('employee_id', employeeId)
    .order('login_time', { ascending: false });
  
  if (organizationId) {
    query = query.eq('organization_id', organizationId);
  }
  
  if (startDate) {
    query = query.gte('login_time', startDate);
  }
  
  if (endDate) {
    query = query.lte('login_time', endDate);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error('Error fetching employee sessions:', error);
    return [];
  }
  
  return data || [];
};

// Real-time status tracking
export const getEmployeeRealTimeStatus = async (employeeId: string, organizationId: string) => {
  try {
    console.log('🔍 Checking real-time status for employee:', employeeId, 'org:', organizationId);
    
    // Get the most recent active session from the last 2 hours (instead of 15 minutes)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    
    // First, let's check what sessions exist for this employee
    const { data: allSessions, error: allSessionsError } = await supabase
      .from('sessions')
      .select('*')
      .eq('employee_id', employeeId)
      .order('login_time', { ascending: false })
      .limit(5);
    
    if (allSessionsError) {
      console.error('❌ Error fetching all sessions:', allSessionsError);
    } else {
      console.log('📋 All sessions for employee:', allSessions?.length || 0);
      allSessions?.forEach(session => {
        console.log(`  - Session ${session.id}: ${session.is_active ? 'ACTIVE' : 'INACTIVE'}, Login: ${session.login_time}`);
      });
    }
    
    const { data: sessions, error: sessionError } = await supabase
      .from('sessions')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .gte('login_time', twoHoursAgo)
      .order('login_time', { ascending: false })
      .limit(1);

    if (sessionError) {
      console.error('❌ Session query error:', sessionError);
      return {
        isOnline: false,
        sessionDuration: 0,
        loginTime: null,
        lastActivity: null
      };
    }

    const session = sessions && sessions.length > 0 ? sessions[0] : null;

    if (session) {
      const loginTime = new Date(session.login_time);
      const now = new Date();
      const sessionDuration = Math.floor((now.getTime() - loginTime.getTime()) / 1000 / 60); // minutes

      // Additional check: if session is older than 2 hours, consider offline
      if (sessionDuration > 120) {
        console.log(`⚠️ Session ${session.id} is too old (${sessionDuration} minutes), marking as offline`);
        return {
          isOnline: false,
          sessionDuration: 0,
          loginTime: null,
          lastActivity: null
        };
      }

      console.log('✅ Employee is online, session duration:', sessionDuration, 'minutes');
      return {
        isOnline: true,
        sessionDuration,
        loginTime: session.login_time,
        lastActivity: session.login_time // In a real app, you'd track last activity separately
      };
    }

    console.log('❌ No active session found, employee is offline');
    return {
      isOnline: false,
      sessionDuration: 0,
      loginTime: null,
      lastActivity: null
    };
  } catch (error) {
    console.error('❌ Error fetching employee real-time status:', error);
    return {
      isOnline: false,
      sessionDuration: 0,
      loginTime: null,
      lastActivity: null
    };
  }
};

// Get current activity for an employee (most recent active app or web activity)
export const getEmployeeCurrentActivity = async (employeeId: string, organizationId: string) => {
  try {
    console.log('🔍 Checking current activity for employee:', employeeId, 'org:', organizationId);
    
    // Get the most recent app usage from the last 2 hours (matching session window)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    
    // First, check for current activity records (real-time activity tracking)
    // Since activity_type column might not exist, we'll look for active records with no end_time
    const { data: currentActivityRecords, error: currentActivityError } = await supabase
      .from('app_usage')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .is('end_time', null)
      .order('start_time', { ascending: false })
      .limit(1);

    if (currentActivityError) {
      console.error('❌ Current activity query error:', currentActivityError);
    } else if (currentActivityRecords && currentActivityRecords.length > 0) {
      const currentActivity = currentActivityRecords[0];
      console.log('📱 Current activity found:', currentActivity.app_name);
      return {
        type: 'app',
        app_name: currentActivity.app_name,
        window_title: currentActivity.window_title || currentActivity.app_name,
        timestamp: currentActivity.start_time,
        duration_seconds: currentActivity.duration_seconds || 0
      };
    }
    
    // If no current activity record, fall back to checking regular app usage
    const { data: allAppUsage, error: allAppError } = await supabase
      .from('app_usage')
      .select('*')
      .eq('employee_id', employeeId)
      .order('start_time', { ascending: false })
      .limit(5);
    
    if (allAppError) {
      console.error('❌ Error fetching all app usage:', allAppError);
    } else {
      console.log('📱 All app usage for employee:', allAppUsage?.length || 0);
      allAppUsage?.forEach(app => {
        console.log(`  - App ${app.id}: ${app.app_name}, Start: ${app.start_time}, Active: ${app.is_active}, End: ${app.end_time || 'null'}`);
      });
    }
    
    const { data: appActivities, error: appError } = await supabase
      .from('app_usage')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .gte('start_time', twoHoursAgo)
      .order('start_time', { ascending: false })
      .limit(1);

    if (appError) {
      console.error('❌ App usage query error:', appError);
    }

    // First, let's check what web activity exists for this employee
    const { data: allWebActivity, error: allWebError } = await supabase
      .from('web_activity')
      .select('*')
      .eq('employee_id', employeeId)
      .order('start_time', { ascending: false })
      .limit(5);
    
    if (allWebError) {
      console.error('❌ Error fetching all web activity:', allWebError);
    } else {
      console.log('🌐 All web activity for employee:', allWebActivity?.length || 0);
      allWebActivity?.forEach(web => {
        console.log(`  - Web ${web.id}: ${web.url}, Start: ${web.start_time}, Active: ${web.is_active}`);
      });
    }

    // Get the most recent web activity from the last 2 hours (matching session window)
    const { data: webActivities, error: webError } = await supabase
      .from('web_activity')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .gte('start_time', twoHoursAgo)
      .order('start_time', { ascending: false })
      .limit(1);

    if (webError) {
      console.error('❌ Web activity query error:', webError);
    }

    const appActivity = appActivities && appActivities.length > 0 ? appActivities[0] : null;
    const webActivity = webActivities && webActivities.length > 0 ? webActivities[0] : null;

    console.log('📱 App activity found:', appActivity ? appActivity.app_name : 'none');
    console.log('🌐 Web activity found:', webActivity ? webActivity.url : 'none');

    // Determine which activity is more recent
    if (appActivity && webActivity) {
      const appTime = new Date(appActivity.start_time);
      const webTime = new Date(webActivity.start_time);
      
      if (appTime > webTime) {
        return {
          type: 'app',
          app_name: appActivity.app_name,
          window_title: appActivity.window_title || appActivity.app_name,
          timestamp: appActivity.start_time,
          duration_seconds: appActivity.duration_seconds || 0
        };
      } else {
        return {
          type: 'web',
          domain: webActivity.domain || new URL(webActivity.url).hostname,
          title: webActivity.title || webActivity.url,
          url: webActivity.url,
          timestamp: webActivity.start_time,
          duration_seconds: webActivity.duration_seconds || 0
        };
      }
    } else if (appActivity) {
      return {
        type: 'app',
        app_name: appActivity.app_name,
        window_title: appActivity.window_title || appActivity.app_name,
        timestamp: appActivity.start_time,
        duration_seconds: appActivity.duration_seconds || 0
      };
    } else if (webActivity) {
      return {
        type: 'web',
        domain: webActivity.domain || new URL(webActivity.url).hostname,
        title: webActivity.title || webActivity.url,
        url: webActivity.url,
        timestamp: webActivity.start_time,
        duration_seconds: webActivity.duration_seconds || 0
      };
    }

    console.log('❌ No current activity found');
    return null; // No current activity found
  } catch (error) {
    console.error('❌ Error fetching employee current activity:', error);
    return null;
  }
};

// Settings and preferences functions
export const updateEmployeePreferences = async (employeeId: string, preferences: any) => {
  try {
    const { error } = await supabase
      .from('employees')
      .update({ 
        updated_at: new Date().toISOString(),
        // Add preferences field if it exists in your schema
      })
      .eq('id', employeeId);
    
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error updating employee preferences:', error);
    return { success: false, error };
  }
};

// Cache management
export const clearAppCache = async () => {
  try {
    // Clear any cached data
    localStorage.clear();
    return { success: true };
  } catch (error) {
    console.error('Error clearing cache:', error);
    return { success: false, error };
  }
};

// Export data functionality
export const exportEmployeeData = async (employeeId: string, organizationId: string, format: 'json' | 'csv' = 'json') => {
  try {
    const report = await generateEmployeeReport(employeeId, organizationId, 
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
      new Date().toISOString()
    );
    
    if (!report) {
      throw new Error('Failed to generate report');
    }
    
    if (format === 'csv') {
      return convertToCSV(report);
    }
    
    return JSON.stringify(report, null, 2);
  } catch (error) {
    console.error('Error exporting employee data:', error);
    throw error;
  }
};

const convertToCSV = (data: any) => {
  // Simple CSV conversion - you might want to use a library like papaparse
  const headers = Object.keys(data.summary);
  const values = Object.values(data.summary);
  
  return [headers.join(','), values.join(',')].join('\n');
};

export const getDailySummaries = async (employeeId: string, startDate?: string, endDate?: string) => {
  try {
    let query = supabase
      .from('daily_summaries')
      .select('*')
      .eq('employee_id', employeeId)
      .order('date', { ascending: false });

    if (startDate) {
      query = query.gte('date', startDate);
    }
    if (endDate) {
      query = query.lte('date', endDate);
    }

    const { data, error } = await query;
    
    if (error) {
      console.error('Error fetching daily summaries:', error);
      return [];
    }

    console.log('Daily summaries fetched:', data?.length || 0, 'records');
    
    // If no daily summaries exist, generate them from raw data
    if (!data || data.length === 0) {
      console.log('No daily summaries found, generating from raw data...');
      return await generateDailySummariesFromRawData(employeeId, startDate, endDate);
    }
    
    return data || [];
  } catch (error) {
    console.error('Error in getDailySummaries:', error);
    return [];
  }
};

// Generate daily summaries from raw data when they don't exist
const generateDailySummariesFromRawData = async (employeeId: string, startDate?: string, endDate?: string) => {
  try {
    console.log('Generating daily summaries from raw data for employee:', employeeId);
    
    // Get all app usage, web activity, and activity logs for the employee
    const [appUsage, webActivity, activityLogs] = await Promise.all([
      getAppUsage(undefined, employeeId, startDate, endDate),
      getWebActivity(undefined, employeeId, startDate, endDate),
      getActivityLogs(undefined, employeeId, startDate, endDate)
    ]);
    
    // Group data by date
    const dailyData: Record<string, any> = {};
    
    // Process app usage
    appUsage.forEach(app => {
      const date = new Date(app.start_time).toISOString().split('T')[0];
      if (!dailyData[date]) {
        dailyData[date] = {
          app_summary: [],
          web_summary: [],
          activity_summary: [],
          total_active_time: 0,
          total_sessions: 0
        };
      }
      
      const appDuration = app.duration_seconds || 0;
      dailyData[date].total_active_time += appDuration;
      
      // Group apps by name
      const existingApp = dailyData[date].app_summary.find((a: any) => a.app_name === app.app_name);
      if (existingApp) {
        existingApp.total_time += appDuration;
        existingApp.session_count += 1;
      } else {
        dailyData[date].app_summary.push({
          app_name: app.app_name,
          total_time: appDuration,
          session_count: 1,
          window_title: app.window_title
        });
      }
    });
    
    // Process web activity
    webActivity.forEach(web => {
      const date = new Date(web.start_time).toISOString().split('T')[0];
      if (!dailyData[date]) {
        dailyData[date] = {
          app_summary: [],
          web_summary: [],
          activity_summary: [],
          total_active_time: 0,
          total_sessions: 0
        };
      }
      
      const webDuration = web.duration_seconds || 0;
      dailyData[date].total_active_time += webDuration;
      
      // Group by domain
      const domain = web.domain || 'Unknown';
      const existingWeb = dailyData[date].web_summary.find((w: any) => w.domain === domain);
      if (existingWeb) {
        existingWeb.total_time += webDuration;
        existingWeb.visit_count += 1;
      } else {
        dailyData[date].web_summary.push({
          domain,
          total_time: webDuration,
          visit_count: 1,
          url: web.url,
          title: web.title
        });
      }
    });
    
    // Process activity logs
    activityLogs.forEach(log => {
      const date = new Date(log.timestamp).toISOString().split('T')[0];
      if (!dailyData[date]) {
        dailyData[date] = {
          app_summary: [],
          web_summary: [],
          activity_summary: [],
          total_active_time: 0,
          total_sessions: 0
        };
      }
      
      // Group by activity type
      const existingActivity = dailyData[date].activity_summary.find((a: any) => a.activity_type === log.activity_type);
      if (existingActivity) {
        existingActivity.frequency += 1;
      } else {
        dailyData[date].activity_summary.push({
          activity_type: log.activity_type,
          frequency: 1,
          description: log.description
        });
      }
    });
    
    // Convert to daily summary format
    const summaries = Object.entries(dailyData).map(([date, data]) => {
      const mostUsedApp = data.app_summary.length > 0 
        ? data.app_summary.reduce((max: any, app: any) => app.total_time > max.total_time ? app : max).app_name 
        : null;
      
      const mostVisitedDomain = data.web_summary.length > 0 
        ? data.web_summary.reduce((max: any, web: any) => web.total_time > max.total_time ? web : max).domain 
        : null;
      
      return {
        id: `generated-${date}`,
        employee_id: employeeId,
        organization_id: '', // Will be filled by the actual data
        date,
        app_summary: data.app_summary,
        web_summary: data.web_summary,
        activity_summary: data.activity_summary,
        total_active_time: data.total_active_time,
        total_sessions: data.app_summary.length + data.web_summary.length,
        most_used_app: mostUsedApp,
        most_visited_domain: mostVisitedDomain,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    });
    
    console.log('Generated daily summaries:', summaries.length, 'days');
    return summaries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
  } catch (error) {
    console.error('Error generating daily summaries from raw data:', error);
    return [];
  }
};

export const getDailySummaryByDate = async (employeeId: string, date: string) => {
  try {
    const { data, error } = await supabase
      .from('daily_summaries')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('date', date)
      .single();

    if (error) {
      console.error('Error fetching daily summary:', error);
      return null;
    }

    console.log('Daily summary fetched for date:', date);
    return data;
  } catch (error) {
    console.error('Error in getDailySummaryByDate:', error);
    return null;
  }
};

export const getAvailableDates = async (employeeId: string) => {
  try {
    const { data, error } = await supabase
      .from('daily_summaries')
      .select('date')
      .eq('employee_id', employeeId)
      .order('date', { ascending: false });

    if (error) {
      console.error('Error fetching available dates:', error);
      return [];
    }

    const dates = data?.map(item => item.date) || [];
    console.log('Available dates:', dates.length, 'dates');
    return dates;
  } catch (error) {
    console.error('Error in getAvailableDates:', error);
    return [];
  }
};

export const getProjects = async (organizationId: string): Promise<Project[]> => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('name', { ascending: true });
    
    if (error) {
      console.error('❌ Error fetching projects:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error fetching projects:', error);
    return [];
  }
};

export const getEmployeeCurrentProject = async (employeeId: string, organizationId: string): Promise<string | null> => {
  try {
    console.log('🔍 Getting current project for employee:', employeeId, 'org:', organizationId);
    
    // Get the most recent active app_usage record
    const { data: currentAppData, error: appError } = await supabase
      .from('app_usage')
      .select('current_project')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .is('end_time', null)
      .order('start_time', { ascending: false })
      .limit(1);

    if (appError) {
      console.error('❌ Error fetching current app project:', appError);
    } else if (currentAppData && currentAppData.length > 0) {
      const currentProject = currentAppData[0].current_project;
      console.log('✅ Current project found:', currentProject);
      return currentProject;
    }
    
    // Fallback: check activity_logs for recent project switches
    const { data: recentActivityData, error: activityError } = await supabase
      .from('activity_logs')
      .select('metadata')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .eq('activity_type', 'project_switch')
      .not('metadata', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(1);

    if (activityError) {
      console.error('❌ Error fetching recent activity project:', activityError);
    } else if (recentActivityData && recentActivityData.length > 0) {
      const currentProject = recentActivityData[0].metadata?.current_project;
      console.log('✅ Current project from activity logs:', currentProject);
      return currentProject;
    }
    
    console.log('❌ No current project found');
    return null;
    
  } catch (error) {
    console.error('❌ Error getting current project:', error);
    return null;
  }
};

export const getEmployeeProjects = async (employeeId: string, organizationId: string): Promise<Project[]> => {
  try {
    console.log('🔍 Getting projects for employee:', employeeId, 'org:', organizationId);
    
    // Get all unique projects that this employee has worked on
    const projects = new Set<string>();
    let hasNoProjectRecords = false;
    
    // 1. Get projects from app_usage table
    const { data: appUsageData, error: appError } = await supabase
      .from('app_usage')
      .select('current_project')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId);
    
    if (appError) {
      console.error('❌ Error fetching app usage projects:', appError);
    } else if (appUsageData) {
      appUsageData.forEach(app => {
        if (app.current_project && app.current_project.trim() !== '') {
          projects.add(app.current_project);
        } else {
          hasNoProjectRecords = true;
        }
      });
    }
    
    // 2. Get projects from web_activity table
    const { data: webActivityData, error: webError } = await supabase
      .from('web_activity')
      .select('current_project')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId);
    
    if (webError) {
      console.error('❌ Error fetching web activity projects:', webError);
    } else if (webActivityData) {
      webActivityData.forEach(web => {
        if (web.current_project && web.current_project.trim() !== '') {
          projects.add(web.current_project);
        } else {
          hasNoProjectRecords = true;
        }
      });
    }
    
    // 3. Get projects from activity_logs metadata
    const { data: activityLogsData, error: activityError } = await supabase
      .from('activity_logs')
      .select('metadata')
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .not('metadata', 'is', null);
    
    if (activityError) {
      console.error('❌ Error fetching activity logs projects:', activityError);
    } else if (activityLogsData) {
      activityLogsData.forEach(log => {
        if (log.metadata?.current_project) {
          projects.add(log.metadata.current_project);
        }
      });
    }
    
    // Get the current project to mark it as active
    const currentProject = await getEmployeeCurrentProject(employeeId, organizationId);
    
    // Convert project names to Project objects
    const projectNames = Array.from(projects);
    console.log('📋 Employee projects found:', projectNames);
    console.log('🎯 Current project:', currentProject);
    
    // Create Project objects for each unique project
    const employeeProjects: Project[] = projectNames.map(projectName => ({
      id: `generated-${projectName}`, // Generate a temporary ID
      organization_id: organizationId,
      name: projectName,
      description: `Project: ${projectName}`,
      created_by: employeeId,
      is_active: projectName === currentProject, // Mark current project as active
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));
    
    // Add "No Project" option if there are records without project assignment
    if (hasNoProjectRecords) {
      employeeProjects.unshift({
        id: 'no-project',
        organization_id: organizationId,
        name: 'No Project',
        description: 'Activity not assigned to any specific project',
        created_by: employeeId,
        is_active: currentProject === null, // Mark as active only if no current project
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
    
    // Sort by name (but keep "No Project" at the top)
    const noProjectItem = employeeProjects.find(p => p.name === 'No Project');
    const otherProjects = employeeProjects.filter(p => p.name !== 'No Project').sort((a, b) => a.name.localeCompare(b.name));
    
    const finalProjectList = noProjectItem ? [noProjectItem, ...otherProjects] : otherProjects;
    
    console.log('✅ Employee projects loaded:', finalProjectList.length, 'projects');
    return finalProjectList;
    
  } catch (error) {
    console.error('❌ Error fetching employee projects:', error);
    return [];
  }
}; 