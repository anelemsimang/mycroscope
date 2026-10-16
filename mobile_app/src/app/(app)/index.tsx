import { Redirect, type Href } from 'expo-router';

import { useSession } from '@/lib/session';

/** The public site owns /. Inside the app, / opens the signed-in home. */
export default function AppHome() {
  const { isManager } = useSession();
  return <Redirect href={(isManager ? '/overview' : '/me') as Href} />;
}
