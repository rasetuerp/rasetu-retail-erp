import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, KeyRound, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

// RULES.md #2: types declared inline, no cross-page imports (api.ts/session.ts/
// theme.ts are shared infrastructure). RULES.md #3: text inputs use
// defaultValue+refs, never onChange — checkboxes/selects here are controlled
// state instead, matching the existing precedent in LabelsPage.tsx/ItemMasterPage.tsx.
// Round 3 Step 3 — ADMIN/SUPER_ADMIN only. Reached only via App.tsx's NAV gate.

type Tab = 'dashboard' | 'billing' | 'items' | 'purchase' | 'parties' | 'reports' | 'labels' | 'settings';

const ASSIGNABLE_TABS: Array<{ tab: Tab; label: string }> = [
  { tab: 'dashboard', label: 'Dashboard' },
  { tab: 'billing', label: 'GST Billing' },
  { tab: 'items', label: 'Item / Stock Master' },
  { tab: 'purchase', label: 'Purchase Entry' },
  { tab: 'parties', label: 'Parties & Ledger' },
  { tab: 'reports', label: 'Reports & GST Pack' },
  { tab: 'labels', label: 'Barcode Labels' },
  { tab: 'settings', label: 'Settings' },
];

type TeamUser = {
  id: string;
  name: string;
  username: string;
  role: 'ADMIN' | 'STAFF' | 'SUPER_ADMIN';
  permissions: Tab[] | null;
  hasPin: boolean;
  isActive: boolean;
};

const { color } = theme;
const inputStyle: React.CSSProperties = { padding: 9, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14, width: '100%' };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: color.inkSoft };

function PasswordField({ innerRef, placeholder }: { innerRef: React.RefObject<HTMLInputElement | null>; placeholder?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input ref={innerRef} defaultValue="" type={visible ? 'text' : 'password'} placeholder={placeholder} style={{ ...inputStyle, paddingRight: 34 }} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: color.inkFaint, display: 'flex' }}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

function PermissionChecklist({ selected, onToggle }: { selected: Tab[] | null; onToggle: (tab: Tab) => void }) {
  const fullAccess = selected === null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px 14px' }}>
      {ASSIGNABLE_TABS.map(({ tab, label }) => (
        <label key={tab} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: color.inkSoft }}>
          <input type="checkbox" checked={fullAccess || selected.includes(tab)} onChange={() => onToggle(tab)} />
          {label}
        </label>
      ))}
    </div>
  );
}

export function UsersPage() {
  const { session } = useSession();
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [newRole, setNewRole] = useState<'ADMIN' | 'STAFF'>('STAFF');
  const [newPermissions, setNewPermissions] = useState<Tab[] | null>(null); // null = full access
  const nameRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const [resetTargetId, setResetTargetId] = useState<string | null>(null);
  const resetPasswordRef = useRef<HTMLInputElement>(null);
  const [editPermsTargetId, setEditPermsTargetId] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Tab[] | null>(null);

  async function loadUsers() {
    if (!session) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ users: TeamUser[] }>(`/companies/${session.companyId}/users`, { token: session.token });
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  function toggleNewPermission(tab: Tab) {
    setNewPermissions((prev) => {
      const base = prev ?? ASSIGNABLE_TABS.map((t) => t.tab);
      const next = base.includes(tab) ? base.filter((t) => t !== tab) : [...base, tab];
      return next.length === ASSIGNABLE_TABS.length ? null : next;
    });
  }

  async function handleAddUser() {
    if (!session) return;
    setError(null);
    setStatus(null);
    setSaving(true);
    try {
      await apiRequest(`/companies/${session.companyId}/users`, {
        method: 'POST',
        token: session.token,
        body: {
          name: nameRef.current?.value ?? '',
          username: usernameRef.current?.value ?? '',
          password: passwordRef.current?.value ?? '',
          role: newRole,
          permissions: newRole === 'ADMIN' ? null : newPermissions,
        },
      });
      if (nameRef.current) nameRef.current.value = '';
      if (usernameRef.current) usernameRef.current.value = '';
      if (passwordRef.current) passwordRef.current.value = '';
      setNewRole('STAFF');
      setNewPermissions(null);
      setStatus('User added.');
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add user');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(user: TeamUser) {
    if (!session) return;
    if (user.isActive && !confirm(`Deactivate ${user.name}? They won't be able to log in until reactivated.`)) return;
    setError(null);
    try {
      await apiRequest(`/companies/${session.companyId}/users/${user.id}`, {
        method: 'PATCH',
        token: session.token,
        body: { isActive: !user.isActive },
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update user');
    }
  }

  async function handleClearPin(user: TeamUser) {
    if (!session) return;
    setError(null);
    try {
      await apiRequest(`/companies/${session.companyId}/users/${user.id}`, {
        method: 'PATCH',
        token: session.token,
        body: { clearPin: true },
      });
      setStatus(`PIN cleared for ${user.name} - they'll log in with their password next time.`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to clear PIN');
    }
  }

  async function handleResetPassword(userId: string) {
    if (!session) return;
    const newPassword = resetPasswordRef.current?.value ?? '';
    setError(null);
    try {
      await apiRequest(`/companies/${session.companyId}/users/${userId}`, {
        method: 'PATCH',
        token: session.token,
        body: { resetPassword: newPassword },
      });
      setStatus('Password reset - let them know their new password in person.');
      setResetTargetId(null);
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset password');
    }
  }

  async function handleSavePermissions(userId: string) {
    if (!session) return;
    setError(null);
    try {
      await apiRequest(`/companies/${session.companyId}/users/${userId}`, {
        method: 'PATCH',
        token: session.token,
        body: { permissions: editPerms },
      });
      setStatus('Access updated.');
      setEditPermsTargetId(null);
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update access');
    }
  }

  if (loading) {
    return <div style={{ padding: 28, color: color.inkFaint, fontSize: 13 }}>Loading…</div>;
  }

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Team &amp; Access</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>
        Add staff accounts and control which modules each person can see. Forgot a password or PIN? Reset it here.
      </p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {status && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{status}</div>}

      <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm, marginBottom: 24, maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14, color: color.ink, marginBottom: 12 }}>
          <UserPlus size={16} /> Add a user
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={labelStyle}>Name<input ref={nameRef} defaultValue="" style={inputStyle} placeholder="Full name" /></label>
          <label style={labelStyle}>Username<input ref={usernameRef} defaultValue="" style={inputStyle} placeholder="min 3 characters" /></label>
          <label style={labelStyle}>Password<PasswordField innerRef={passwordRef} placeholder="min 6 characters" /></label>
          <label style={labelStyle}>
            Role
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as 'ADMIN' | 'STAFF')} style={{ ...inputStyle, width: 160 }}>
              <option value="STAFF">Staff</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>
          {newRole === 'STAFF' && (
            <div>
              <div style={{ fontSize: 12, color: color.inkSoft, marginBottom: 6 }}>Visible modules (leave all checked for full access)</div>
              <PermissionChecklist selected={newPermissions} onToggle={toggleNewPermission} />
            </div>
          )}
          <button
            onClick={() => void handleAddUser()}
            disabled={saving}
            style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600, alignSelf: 'flex-start', marginTop: 4 }}
          >
            {saving ? 'Adding…' : 'Add User'}
          </button>
        </div>
      </div>

      <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, boxShadow: theme.shadowSm, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: color.lineSoft, textAlign: 'left' }}>
              <th style={{ padding: '10px 14px' }}>Name</th>
              <th style={{ padding: '10px 14px' }}>Username</th>
              <th style={{ padding: '10px 14px' }}>Role</th>
              <th style={{ padding: '10px 14px' }}>Modules</th>
              <th style={{ padding: '10px 14px' }}>PIN</th>
              <th style={{ padding: '10px 14px' }}>Status</th>
              <th style={{ padding: '10px 14px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: `1px solid ${color.lineSoft}`, opacity: u.isActive ? 1 : 0.5 }}>
                <td style={{ padding: '10px 14px' }}>{u.name}</td>
                <td style={{ padding: '10px 14px', fontFamily: theme.mono, color: color.inkSoft }}>{u.username}</td>
                <td style={{ padding: '10px 14px' }}>{u.role}</td>
                <td style={{ padding: '10px 14px', color: color.inkSoft }}>
                  {u.role !== 'STAFF' ? 'All' : u.permissions === null ? 'All' : u.permissions.length ? u.permissions.join(', ') : 'None'}
                  {u.role === 'STAFF' && editPermsTargetId !== u.id && (
                    <button
                      onClick={() => { setEditPermsTargetId(u.id); setEditPerms(u.permissions); }}
                      style={{ marginLeft: 8, border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}
                    >
                      Edit
                    </button>
                  )}
                  {editPermsTargetId === u.id && (
                    <div style={{ marginTop: 8, padding: 10, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, background: color.paper }}>
                      <PermissionChecklist
                        selected={editPerms}
                        onToggle={(tab) => setEditPerms((prev) => {
                          const base = prev ?? ASSIGNABLE_TABS.map((t) => t.tab);
                          const next = base.includes(tab) ? base.filter((t) => t !== tab) : [...base, tab];
                          return next.length === ASSIGNABLE_TABS.length ? null : next;
                        })}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button onClick={() => void handleSavePermissions(u.id)} style={{ padding: '6px 12px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12 }}>Save</button>
                        <button onClick={() => setEditPermsTargetId(null)} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </td>
                <td style={{ padding: '10px 14px' }}>{u.hasPin ? 'Set' : '-'}</td>
                <td style={{ padding: '10px 14px' }}>{u.isActive ? 'Active' : 'Inactive'}</td>
                <td style={{ padding: '10px 14px' }}>
                  {u.role === 'SUPER_ADMIN' ? (
                    <span style={{ color: color.inkFaint, fontSize: 12 }}>Managed by vendor</span>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button
                          onClick={() => setResetTargetId(resetTargetId === u.id ? null : u.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 12 }}
                        >
                          <KeyRound size={13} /> Reset password
                        </button>
                        {u.hasPin && (
                          <button onClick={() => void handleClearPin(u)} style={{ border: 'none', background: 'transparent', color: color.inkSoft, cursor: 'pointer', fontSize: 12 }}>
                            Clear PIN
                          </button>
                        )}
                        <button
                          onClick={() => void handleToggleActive(u)}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', color: u.isActive ? color.alert : color.money, cursor: 'pointer', fontSize: 12 }}
                        >
                          {u.isActive ? <><ShieldOff size={13} /> Deactivate</> : <><ShieldCheck size={13} /> Reactivate</>}
                        </button>
                      </div>
                      {resetTargetId === u.id && (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                          <div style={{ width: 200 }}>
                            <PasswordField innerRef={resetPasswordRef} placeholder="New password (min 6 chars)" />
                          </div>
                          <button onClick={() => void handleResetPassword(u.id)} style={{ padding: '7px 12px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12 }}>Set</button>
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
