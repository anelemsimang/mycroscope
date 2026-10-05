import type { Session } from '@supabase/supabase-js';
import { createContext, use, useCallback, useEffect, useState, type PropsWithChildren } from 'react';

import type { Role, ServiceStatus } from './api';
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

export type Aal = 'aal1' | 'aal2';

interface SessionValue {
  session: Session | null;
  profile: Profile | null;
  /** Signed in as a platform operator (the SaaS provider) rather than an organisation member. */
  operator: boolean;
  /** Assurance level of this session, and the level the account could reach (aal2 once a factor is verified). */
  aal: { current: Aal; next: Aal };
  /** The account has two-factor login but this session has not passed the second step yet. */
  needsMfaChallenge: boolean;
  service: ServiceStatus | null;
  isLoading: boolean;
  /** Shown on the sign-in screen after a forced sign-out (deactivated, unlinked). */
  notice: string | null;
  isManager: boolean;
  signOut: () => Promise<void>;
  reloadProfile: () => Promise<void>;
  reloadService: () => Promise<void>;
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

type Loaded = { kind: 'member'; profile: Profile } | { kind: 'operator' } | { kind: 'rejected'; message: string };

async function fetchProfile(userId: string): Promise<Loaded> {
  const { data: emp, error } = await supabase
    .from('employees')
    .select('id,organization_id,name,email,employee_code,role,is_active')
    .eq('auth_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!emp) {
    const { data: isOperator, error: opError } = await supabase.rpc('am_i_platform_admin');
    if (opError) throw opError;
    if (isOperator) return { kind: 'operator' };
    return { kind: 'rejected', message: 'This account is not linked to an organisation.' };
  }
  if (!emp.is_active) return { kind: 'rejected', message: 'Your account has been deactivated. Contact your organisation owner.' };
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('name,timezone')
    .eq('id', emp.organization_id)
    .single();
  if (orgError) throw orgError;
  return {
    kind: 'member',
    profile: {
      employeeId: emp.id,
      organizationId: emp.organization_id,
      name: emp.name,
      email: emp.email,
      employeeCode: emp.employee_code,
      role: emp.role as Role,
      organizationName: org.name,
      timezone: org.timezone || 'Africa/Johannesburg',
    },
  };
}

async function fetchService(): Promise<ServiceStatus | null> {
  const { data, error } = await supabase.rpc('get_my_service_status');
  if (error) return null;
  return ((data ?? []) as ServiceStatus[])[0] ?? null;
}

async function fetchAal(): Promise<{ current: Aal; next: Aal }> {
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return { current: (data?.currentLevel as Aal) ?? 'aal1', next: (data?.nextLevel as Aal) ?? 'aal1' };
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [operator, setOperator] = useState(false);
  const [aal, setAal] = useState<{ current: Aal; next: Aal }>({ current: 'aal1', next: 'aal1' });
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (s: Session | null) => {
    if (!s) {
      setSession(null);
      setProfile(null);
      setOperator(false);
      setService(null);
      setAal({ current: 'aal1', next: 'aal1' });
      setLoading(false);
      return;
    }
    try {
      const levels = await fetchAal();
      setAal(levels);
      const result = await fetchProfile(s.user.id);
      if (result.kind === 'rejected') {
        setNotice(result.message);
        await supabase.auth.signOut();
        setSession(null);
        setProfile(null);
        setOperator(false);
      } else {
        setNotice(null);
        setOperator(result.kind === 'operator');
        setProfile(result.kind === 'member' ? result.profile : null);
        setService(result.kind === 'member' ? await fetchService() : null);
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
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED' || event === 'MFA_CHALLENGE_VERIFIED') {
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
    operator,
    aal,
    needsMfaChallenge: !!session && aal.next === 'aal2' && aal.current !== 'aal2',
    service,
    isLoading,
    notice,
    isManager: profile?.role === 'owner' || profile?.role === 'manager',
    signOut: async () => {
      await supabase.auth.signOut();
    },
    reloadProfile: async () => load((await supabase.auth.getSession()).data.session),
    reloadService: async () => setService(await fetchService()),
  };

  return <SessionContext value={value}>{children}</SessionContext>;
}
