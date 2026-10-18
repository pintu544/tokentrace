import { getSession } from '@/lib/api';
import { KeysClient } from './keys-client';

export default async function KeysPage() {
  const user = await getSession();
  // Keys load client-side (they change after issue/revoke); the role gates admin UI.
  return <KeysClient role={user?.role || 'viewer'} />;
}
