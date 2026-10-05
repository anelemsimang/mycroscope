import type { Session } from '@supabase/supabase-js';
import { createContext, use, useCallback, useEffect, useState, type PropsWithChildren } from 'react';

import type { Role } from './api';
import { supabase } from './supabase';

export interface Profile {
  employeeId: string;
  organizationId: string;
  name: string;
  email: string;
  employeeCode: string;
  role: Role;
  organizationName: string;
  timezone: string;
}

interface SessionValue {
  session: Session | null;
  profile: Profile | null;
  isLoading: boolean;
  /** Shown on the sign-in screen after a forced sign-out (deactivated, unlinked). */
  notice: string | null;
  isManager: boolean;
  signOut: () => Promise<void>;
  reloadProfile: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = use(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

/** Profile of the signed-in user; only valid inside the signed-in part of the app. */
export function useProfile(): Profile {
  const { profile } = useSession();
  if (!profile) throw new Error('No profile loaded');
  return profile;
}

async function fetchProfile(userId: string): Promise<Profile | string> {
  const { data: emp, error } = await supabase
    .from('employees')
    .select('id,organization_id,name,email,employee_code,role,is_active')
    .eq('auth_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!emp) return 'This account is not linked to an organisation.';
  if (!emp.is_active) return 'Your account has been deactivated. Contact your organisation owner.';
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('name,timezone')
    .eq('id', emp.organization_id)
    .single();
  if (orgError) throw orgError;
  return {
    employeeId: emp.id,
    organizationId: emp.organization_id,
    name: emp.name,
    email: emp.email,
    employeeCode: emp.employee_code,
    role: emp.role as Role,
    organizationName: org.name,
    timezone: org.timezone || 'Africa/Johannesburg',
  };
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (s: Session | null) => {
    if (!s) {
      setSession(null);
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      const result = await fetchProfile(s.user.id);
      if (typeof result === 'string') {
        setNotice(result);
        await supabase.auth.signOut();
        setSession(null);
        setProfile(null);
      } else {
        setNotice(null);
        setProfile(result);
        setSession(s);
      }
    } catch {
      // Offline at launch: keep the session; screens show their own errors and retry.
      setSession(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => load(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Defer: calling Supabase inside this callback can deadlock the auth lock.
        setTimeout(() => load(s), 0);
      } else if (event === 'TOKEN_REFRESHED') {
        setSession(s);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const value: SessionValue = {
    session,
    profile,
    isLoading,
    notice,
    isManager: profile?.role === 'owner' || profile?.role === 'manager',
    signOut: async () => {
      await supabase.auth.signOut();
    },
    reloadProfile: async () => load((await supabase.auth.getSession()).data.session),
  };

  return <SessionContext value={value}>{children}</SessionContext>;
}
