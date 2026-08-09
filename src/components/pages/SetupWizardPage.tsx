import { useEffect, useRef, useState } from 'react';
import { Delete, Eye, EyeOff } from 'lucide-react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession, type Session, type SessionUser } from '../../lib/session';
import { theme } from '../../lib/theme';
import { requestPasswordReset, PasswordResetError } from '../../lib/passwordReset';
import { BRAND_LOGO_DARK } from '../../lib/assets';

// RULES.md #2: types declared inline, no cross-page imports (api.ts/session.ts/
// theme.ts are shared infrastructure, same exemption as exportUtils.ts).
// Round 8 — company-first boot flow (fixes "I don't know my username and
// password": you now see which shops exist before being asked for a
// password, instead of typing credentials blind), and a real 3-step new-shop
// wizard (Shop Setup -> Profile Setup -> Owner Account) mirroring GoBilling's
// own license -> shop setup -> profile setup -> login sequence. A fresh
// install with zero companies skips straight to Shop Setup — there is
// nothing to log into yet, so no login screen is shown at all.

type Company = { id: string; name: string; gstin: string | null };
type LoginResponse = { token: string; user: SessionUser & { hasPin: boolean } };
type CreateCompanyResponse = { company: { id: string; name: string }; token: string; user: SessionUser & { hasPin: boolean } };
type SuperLoginResponse = { token: string; user: { id: string; name: string; role: 'SUPER_ADMIN' }; companies: Company[] };
type SuperEnterResponse = { token: string; user: SessionUser; company: { id: string; name: string } };
type VerticalProfile = { key: string; name: string };
// Round 9 — multi-company portable storage. A drive is only offered as a
// storage choice if it's not the system drive (that's covered by the
// default "This computer" option) — see backend/src/lib/drives.ts for why
// volumeId (not a drive letter) is the value actually submitted.
type DriveOption = { mountpoint: string; driveLetter: string; label: string | null; volumeId: string; isRemovable: boolean; isSystem: boolean; freeBytes: number | null; totalBytes: number | null };

type RememberedLogin = { companyId: string; companyName: string; userId: string; username: string; name: string; hasPin: boolean };

const REMEMBERED_KEY = 'rasetu-remembered-login';

function loadRemembered(): RememberedLogin | null {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY);
    return raw ? (JSON.parse(raw) as RememberedLogin) : null;
  } catch {
    return null;
  }
}

type Screen =
  | 'shop-picker'
  | 'shop-login'
  | 'new-shop-setup'
  | 'new-shop-profile'
  | 'new-shop-owner'
  | 'set-pin'
  | 'welcome-back'
  | 'vendor-login'
  | 'vendor-console'
  | 'forgot-password-request'
  | 'forgot-password-redeem';

// Holds the fresh session between "shop + admin created" and "PIN set" —
// setSession() is deferred until the guided onboarding PIN step finishes (or
// is skipped), so App.tsx doesn't switch away from the wizard mid-onboarding.
type PendingSession = { companyId: string; companyName: string; token: string; user: SessionUser & { hasPin: boolean }; adminPassword: string };

// Accumulates the new-shop wizard's 3 steps — plain state (not refs), since
// each step's screen unmounts the previous step's input DOM nodes; a later
// step reading an earlier step's ref would find nothing. Same problem this
// file already solved for pendingSession/adminPasswordRef below.
type NewShopDraft = {
  name: string;
  gstin: string;
  address: string;
  phone: string;
  email: string;
  verticalProfileKey: string;
  verticalProfileName: string;
  adminName: string;
  adminUsername: string;
  // Round 9 — null = "This computer" (today's default, unchanged behavior).
  // A volumeId targets a drive GET /system/drives reported; fixed at
  // creation, see docs/PENDING.md for why relocating later isn't built yet.
  storageVolumeId: string | null;
  storageLabel: string | null;
};
const EMPTY_DRAFT: NewShopDraft = {
  name: '',
  gstin: '',
  address: '',
  phone: '',
  email: '',
  verticalProfileKey: 'cloth',
  verticalProfileName: 'Cloth / Garment Store',
  adminName: '',
  adminUsername: '',
  storageVolumeId: null,
  storageLabel: null,
};

const { color } = theme;

const cardStyle: React.CSSProperties = { width: 420, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 28, boxShadow: theme.shadow };
const buttonStyle: React.CSSProperties = { padding: '11px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600, marginTop: 4 };
const linkStyle: React.CSSProperties = { border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 12.5, textDecoration: 'underline', padding: 0 };
const faintLinkStyle: React.CSSProperties = { border: 'none', background: 'transparent', color: color.inkFaint, cursor: 'pointer', fontSize: 11.5, padding: 0 };

function StepIndicator({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: total }, (_, i) => (
          <div key={i} style={{ width: 20, height: 3, borderRadius: 2, background: i < step ? color.brass : color.line }} />
        ))}
      </div>
      <span style={{ fontSize: 11, color: color.inkFaint, fontFamily: theme.mono }}>Step {step} of {total} - {label}</span>
    </div>
  );
}

function Field({ label, innerRef, placeholder, type = 'text', defaultValue = '' }: { label: string; innerRef: React.RefObject<HTMLInputElement | null>; placeholder?: string; type?: string; defaultValue?: string }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: color.inkSoft }}>
      {label}
      <input ref={innerRef} defaultValue={defaultValue} placeholder={placeholder} type={type} style={{ padding: 9, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14 }} />
    </label>
  );
}

function PasswordField({ label, innerRef, placeholder }: { label: string; innerRef: React.RefObject<HTMLInputElement | null>; placeholder?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: color.inkSoft }}>
      {label}
      <div style={{ position: 'relative' }}>
        <input ref={innerRef} defaultValue="" placeholder={placeholder} type={visible ? 'text' : 'password'} style={{ padding: 9, paddingRight: 34, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14, width: '100%' }} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: color.inkFaint, display: 'flex' }}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </label>
  );
}

function PinPad({ onSubmit, disabled }: { onSubmit: (pin: string) => void; disabled?: boolean }) {
  const [digits, setDigits] = useState('');

  function press(d: string) {
    if (disabled || digits.length >= 4) return;
    const next = digits + d;
    setDigits(next);
    if (next.length === 4) {
      onSubmit(next);
      setDigits('');
    }
  }

  function backspace() {
    setDigits((d) => d.slice(0, -1));
  }

  // Lets a keyboard/numpad type the PIN, not just mouse clicks on the dial.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (disabled) return;
      if (e.key >= '0' && e.key <= '9') {
        press(e.key);
      } else if (e.key === 'Backspace') {
        backspace();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, digits]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${color.brass}`, background: i < digits.length ? color.brass : 'transparent' }} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 56px)', gap: 10 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)} disabled={disabled} style={pinKeyStyle}>{d}</button>
        ))}
        <div />
        <button onClick={() => press('0')} disabled={disabled} style={pinKeyStyle}>0</button>
        <button onClick={backspace} disabled={disabled} style={{ ...pinKeyStyle, color: color.inkFaint }} aria-label="Backspace">
          <Delete size={18} style={{ margin: '0 auto' }} />
        </button>
      </div>
    </div>
  );
}

const pinKeyStyle: React.CSSProperties = {
  width: 56, height: 48, borderRadius: theme.radiusSm, border: `1px solid ${color.line}`, background: color.paper,
  fontSize: 18, fontWeight: 600, color: color.ink, cursor: 'pointer',
};

export function SetupWizardPage() {
  const { setSession } = useSession();
  const [rememberedLogin, setRememberedLogin] = useState<RememberedLogin | null>(loadRemembered);
  const [screen, setScreen] = useState<Screen>(() => (loadRemembered() ? 'welcome-back' : 'shop-picker'));
  const [welcomeBackUsePassword, setWelcomeBackUsePassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [manualCompanyId, setManualCompanyId] = useState(false);
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(null);
  // Round 12 — account recovery: forgotRequestId shows the "submitted"
  // confirmation; resetSuccessMessage is a one-shot banner shown back on the
  // shop-login screen after a successful redeem.
  const [forgotRequestId, setForgotRequestId] = useState<string | null>(null);
  const [resetSuccessMessage, setResetSuccessMessage] = useState<string | null>(null);
  // Checked once up front when entering the recovery flow, so an unlicensed
  // device is caught before the user fills out a form it can never submit -
  // null = still checking, otherwise true/false.
  const [recoveryLicenseOk, setRecoveryLicenseOk] = useState<boolean | null>(null);

  const [newShopDraft, setNewShopDraft] = useState<NewShopDraft>(EMPTY_DRAFT);
  const [profiles, setProfiles] = useState<VerticalProfile[]>([]);
  const [drives, setDrives] = useState<DriveOption[]>([]);
  const [selectedVolumeId, setSelectedVolumeId] = useState<string | null>(null);

  const companyNameRef = useRef<HTMLInputElement>(null);
  const gstinRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const adminNameRef = useRef<HTMLInputElement>(null);
  const adminUsernameRef = useRef<HTMLInputElement>(null);
  const adminPasswordRef = useRef<HTMLInputElement>(null);

  const loginCompanyIdRef = useRef<HTMLInputElement>(null);
  const forgotUsernameRef = useRef<HTMLInputElement>(null);
  const forgotContactNoteRef = useRef<HTMLInputElement>(null);
  const redeemUsernameRef = useRef<HTMLInputElement>(null);
  const redeemCodeRef = useRef<HTMLInputElement>(null);
  const redeemNewPasswordRef = useRef<HTMLInputElement>(null);
  const redeemNewPinRef = useRef<HTMLInputElement>(null);
  const loginUsernameRef = useRef<HTMLInputElement>(null);
  const loginPasswordRef = useRef<HTMLInputElement>(null);
  const welcomeBackPasswordRef = useRef<HTMLInputElement>(null);
  const vendorEmailRef = useRef<HTMLInputElement>(null);
  const vendorPasswordRef = useRef<HTMLInputElement>(null);
  const setupPinRef = useRef<HTMLInputElement>(null);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoaded, setCompaniesLoaded] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [selectedCompanyName, setSelectedCompanyName] = useState<string>('your shop');

  const [vendorToken, setVendorToken] = useState<string | null>(null);
  const [vendorCompanies, setVendorCompanies] = useState<Company[]>([]);

  // Round 10 — the single-company auto-skip below must only fire on the
  // very first landing on 'shop-picker' (cold boot / switch-account), never
  // on every loadCompanies() call — otherwise clicking shop-login's "← Back"
  // (which sets screen back to 'shop-picker' on purpose, to reach "+ New
  // shop") would just bounce straight back to login, making Back a dead
  // end. A ref (not state) since it must not itself trigger a re-render/effect.
  const autoSkipAttemptedRef = useRef(false);

  async function loadCompanies() {
    try {
      const res = await apiRequest<{ companies: Company[] }>('/companies');
      setCompanies(res.companies);
      // Nothing to log into yet: skip the picker entirely and go straight
      // into Shop Setup, matching a real first-run install. Exactly one
      // company, and only on the first-ever landing here this session: skip
      // the SELECTION step too and go directly to that company's login —
      // the picker only earns its keep once a second company exists or the
      // user deliberately asks to see it via "← Back".
      if (res.companies.length === 0) {
        setScreen('new-shop-setup');
      } else if (res.companies.length === 1 && !autoSkipAttemptedRef.current) {
        autoSkipAttemptedRef.current = true;
        goToShopLogin(res.companies[0].id, res.companies[0].name);
      }
    } catch {
      // non-fatal — manual company-id entry still works
    } finally {
      setCompaniesLoaded(true);
    }
  }

  useEffect(() => {
    if (screen === 'shop-picker') void loadCompanies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    if (screen !== 'new-shop-profile' || profiles.length > 0) return;
    void apiRequest<{ profiles: VerticalProfile[] }>('/meta/vertical-profiles')
      .then((res) => setProfiles(res.profiles))
      .catch(() => setProfiles([{ key: 'cloth', name: 'Cloth / Garment Store' }]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // Round 9 — fetch on entering Shop Setup so the storage picker's list is
  // fresh (a drive plugged in after the app started still shows up).
  // Non-fatal if it fails: falls back to "This computer" only, same as the
  // profile fetch's fallback above.
  useEffect(() => {
    if (screen !== 'new-shop-setup') return;
    void apiRequest<{ drives: DriveOption[] }>('/system/drives')
      .then((res) => setDrives(res.drives.filter((d) => !d.isSystem)))
      .catch(() => setDrives([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  function rememberLogin(companyId: string, companyName: string, user: SessionUser & { hasPin: boolean }) {
    const entry: RememberedLogin = { companyId, companyName, userId: user.id, username: user.username, name: user.name, hasPin: user.hasPin };
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(entry));
    setRememberedLogin(entry);
  }

  function afterLoginSuccess(companyId: string, companyName: string, token: string, user: SessionUser & { hasPin: boolean }) {
    if (rememberMe) rememberLogin(companyId, companyName, user);
    const session: Session = { companyId, token, user };
    setSession(session);
  }

  function goToShopLogin(id: string, name: string) {
    setSelectedCompanyId(id);
    setSelectedCompanyName(name);
    setError(null);
    setScreen('shop-login');
  }

  function handleNextFromShopSetup() {
    setError(null);
    const name = companyNameRef.current?.value.trim();
    if (!name) {
      setError('Enter your shop name to continue');
      return;
    }
    const selectedDrive = drives.find((d) => d.volumeId === selectedVolumeId) ?? null;
    setNewShopDraft((d) => ({
      ...d,
      name,
      gstin: gstinRef.current?.value.trim() ?? '',
      address: addressRef.current?.value.trim() ?? '',
      phone: phoneRef.current?.value.trim() ?? '',
      email: emailRef.current?.value.trim() ?? '',
      storageVolumeId: selectedDrive?.volumeId ?? null,
      storageLabel: selectedDrive ? (selectedDrive.label ?? selectedDrive.driveLetter) : null,
    }));
    setScreen('new-shop-profile');
  }

  function handleNextFromProfile(profile: VerticalProfile) {
    setNewShopDraft((d) => ({ ...d, verticalProfileKey: profile.key, verticalProfileName: profile.name }));
    setScreen('new-shop-owner');
  }

  async function handleCreateShop() {
    setError(null);
    const adminName = adminNameRef.current?.value.trim() ?? '';
    const adminUsername = adminUsernameRef.current?.value.trim() ?? '';
    // Captured before the request — once the wizard moves to 'set-pin' this
    // screen's fields unmount, taking adminPasswordRef's DOM node (and its
    // .current value) with them.
    const adminPassword = adminPasswordRef.current?.value ?? '';
    if (!adminName || !adminUsername || !adminPassword) {
      setError('Fill in the admin name, username, and password');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest<CreateCompanyResponse>('/companies', {
        method: 'POST',
        body: {
          name: newShopDraft.name,
          gstin: newShopDraft.gstin || undefined,
          address: newShopDraft.address || undefined,
          phone: newShopDraft.phone || undefined,
          email: newShopDraft.email || undefined,
          verticalProfileKey: newShopDraft.verticalProfileKey,
          adminName,
          adminUsername,
          adminPassword,
          storageVolumeId: newShopDraft.storageVolumeId ?? undefined,
        },
      });
      // setSession() is deferred to the guided PIN step below — "shop setup
      // -> profile setup -> owner account -> set a PIN" reads as one
      // onboarding flow, not scattered off into Settings to discover later.
      setPendingSession({ companyId: res.company.id, companyName: res.company.name, token: res.token, user: res.user, adminPassword });
      setScreen('set-pin');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create company');
    } finally {
      setSubmitting(false);
    }
  }

  // Finishes onboarding after 'set-pin' (or its skip) — the one place that
  // actually commits pendingSession into a real Session, mirroring what
  // afterLoginSuccess does for the ordinary login screens.
  function finishOnboarding(hasPin: boolean) {
    if (!pendingSession) return;
    const user = { ...pendingSession.user, hasPin };
    if (rememberMe) rememberLogin(pendingSession.companyId, pendingSession.companyName, user);
    setSession({ companyId: pendingSession.companyId, token: pendingSession.token, user });
    setPendingSession(null);
  }

  async function handleSetupPin() {
    if (!pendingSession) return;
    const pin = setupPinRef.current?.value ?? '';
    if (!/^\d{4}$/.test(pin)) {
      setError('Enter a 4-digit PIN');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest(`/companies/${pendingSession.companyId}/users/me/pin`, {
        method: 'POST',
        token: pendingSession.token,
        body: { currentPassword: pendingSession.adminPassword, pin },
      });
      finishOnboarding(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set PIN');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogin() {
    setError(null);
    const companyId = selectedCompanyId ?? loginCompanyIdRef.current?.value ?? '';
    if (!companyId) {
      setError('Enter a company ID');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest<LoginResponse>(`/companies/${companyId}/auth/login`, {
        method: 'POST',
        body: { username: loginUsernameRef.current?.value ?? '', password: loginPasswordRef.current?.value ?? '' },
      });
      afterLoginSuccess(companyId, selectedCompanyName, res.token, res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePinLogin(pin: string) {
    const entry = rememberedLogin;
    if (!entry) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiRequest<LoginResponse>(`/companies/${entry.companyId}/auth/pin-login`, {
        method: 'POST',
        body: { userId: entry.userId, pin },
      });
      afterLoginSuccess(entry.companyId, entry.companyName, res.token, res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'PIN login failed');
      setWelcomeBackUsePassword(true);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleWelcomeBackPassword() {
    const entry = rememberedLogin;
    if (!entry) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiRequest<LoginResponse>(`/companies/${entry.companyId}/auth/login`, {
        method: 'POST',
        body: { username: entry.username, password: welcomeBackPasswordRef.current?.value ?? '' },
      });
      afterLoginSuccess(entry.companyId, entry.companyName, res.token, res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  function handleNotYou() {
    localStorage.removeItem(REMEMBERED_KEY);
    setRememberedLogin(null);
    setWelcomeBackUsePassword(false);
    setError(null);
    setScreen('shop-picker');
  }

  // Round 12 — opens the "Forgot password / PIN?" flow from either the
  // shop-login screen (selectedCompanyId/Name already set) or welcome-back
  // (only rememberedLogin has the company info, so pass it in explicitly).
  function goToForgotPassword(companyId: string, companyName: string) {
    setSelectedCompanyId(companyId);
    setSelectedCompanyName(companyName);
    setForgotRequestId(null);
    setError(null);
    setRecoveryLicenseOk(null);
    setScreen('forgot-password-request');
    void checkRecoveryLicense();
  }

  async function checkRecoveryLicense() {
    if (!window.rasetu) {
      setRecoveryLicenseOk(false);
      return;
    }
    try {
      const status = await window.rasetu.getStartupLicenseStatus();
      setRecoveryLicenseOk(status.hasValidLicense);
    } catch {
      setRecoveryLicenseOk(false);
    }
  }

  async function handleForgotPasswordRequest() {
    setError(null);
    const username = forgotUsernameRef.current?.value.trim();
    if (!username) {
      setError('Enter your username.');
      return;
    }
    if (!window.rasetu) {
      setError('Account recovery is only available in the desktop app.');
      return;
    }
    setSubmitting(true);
    try {
      const status = await window.rasetu.getStartupLicenseStatus();
      if (!status.hasValidLicense) {
        setError('No active license found on this device - account recovery needs a licensed installation.');
        return;
      }
      const res = await requestPasswordReset({
        licenseKey: status.snapshot.licenseKey,
        companyName: selectedCompanyName,
        username,
        contactNote: forgotContactNoteRef.current?.value.trim() || undefined,
      });
      setForgotRequestId(res.requestId);
    } catch (err) {
      setError(err instanceof PasswordResetError ? err.message : 'Failed to submit request.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgotPasswordRedeem() {
    setError(null);
    const companyId = selectedCompanyId;
    if (!companyId) {
      setError('Something went wrong - go back and select your shop again.');
      return;
    }
    const username = redeemUsernameRef.current?.value.trim();
    const code = redeemCodeRef.current?.value.trim();
    const newPassword = redeemNewPasswordRef.current?.value ?? '';
    const newPin = redeemNewPinRef.current?.value.trim();
    if (!username || !code || newPassword.length < 6) {
      setError('Fill in your username, the reset code, and a new password of at least 6 characters.');
      return;
    }
    if (newPin && !/^\d{4}$/.test(newPin)) {
      setError('PIN must be exactly 4 digits, or leave it blank.');
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest(`/companies/${companyId}/auth/reset-with-code`, {
        method: 'POST',
        body: { username, code, newPassword, newPin: newPin || undefined },
      });
      setResetSuccessMessage('Password updated - log in with your new password.');
      setError(null);
      setScreen('shop-login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset - check the code and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVendorLogin() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiRequest<SuperLoginResponse>('/auth/super-login', {
        method: 'POST',
        body: { email: vendorEmailRef.current?.value ?? '', password: vendorPasswordRef.current?.value ?? '' },
      });
      setVendorToken(res.token);
      setVendorCompanies(res.companies);
      setScreen('vendor-console');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Vendor login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEnterCompany(companyId: string) {
    if (!vendorToken) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiRequest<SuperEnterResponse>(`/auth/super-admin/enter/${companyId}`, {
        method: 'POST',
        token: vendorToken,
      });
      setSession({ companyId, token: res.token, user: res.user });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to enter company');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', background: color.paper, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <div style={cardStyle}>
        <img src={BRAND_LOGO_DARK} alt="RaSetu" style={{ height: 40, marginBottom: 4, display: 'block' }} />
        <div style={{ fontSize: 10, color: '#5C6B78', marginBottom: 10 }}>A brand of Ratan Business Solutions</div>

        {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, margin: '12px 0' }}>{error}</div>}

        {screen === 'welcome-back' && rememberedLogin && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', marginTop: 8 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: color.ink }}>Welcome back, {rememberedLogin.name}</div>
              <div style={{ fontSize: 12.5, color: color.inkFaint }}>{rememberedLogin.companyName}</div>
            </div>

            {rememberedLogin.hasPin && !welcomeBackUsePassword ? (
              <>
                <PinPad onSubmit={(pin) => void handlePinLogin(pin)} disabled={submitting} />
                <button onClick={() => setWelcomeBackUsePassword(true)} style={linkStyle}>Use password instead</button>
              </>
            ) : (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <PasswordField label={`Password for ${rememberedLogin.username}`} innerRef={welcomeBackPasswordRef} placeholder="password" />
                <button onClick={() => void handleWelcomeBackPassword()} disabled={submitting} style={buttonStyle}>
                  {submitting ? 'Logging in…' : 'Login'}
                </button>
                {rememberedLogin.hasPin && (
                  <button onClick={() => setWelcomeBackUsePassword(false)} style={linkStyle}>Use PIN instead</button>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={handleNotYou} style={faintLinkStyle}>Not you? Switch company or account</button>
              <button onClick={() => goToForgotPassword(rememberedLogin.companyId, rememberedLogin.companyName)} style={faintLinkStyle}>Forgot password / PIN?</button>
            </div>
          </div>
        )}

        {screen === 'shop-picker' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {!companiesLoaded ? (
              <p style={{ color: color.inkFaint, fontSize: 13, margin: 0 }}>Loading…</p>
            ) : (
              <>
                <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>Select your shop to continue.</p>

                {companies.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
                    {companies.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => goToShopLogin(c.id, c.name)}
                        style={{
                          textAlign: 'left', padding: '10px 12px', borderRadius: theme.radiusSm, fontSize: 13.5,
                          border: `1px solid ${color.line}`, background: color.paper, color: color.ink, cursor: 'pointer',
                        }}
                      >
                        {c.name}{c.gstin ? <span style={{ color: color.inkFaint }}> - {c.gstin}</span> : null}
                      </button>
                    ))}
                  </div>
                )}

                {manualCompanyId && (
                  <Field label="Company ID" innerRef={loginCompanyIdRef} placeholder="paste the company id" />
                )}
                {manualCompanyId && (
                  <button onClick={() => goToShopLogin(loginCompanyIdRef.current?.value.trim() ?? '', 'your shop')} style={buttonStyle}>
                    Continue
                  </button>
                )}

                <div style={{ borderTop: `1px solid ${color.lineSoft}`, margin: '6px 0' }} />
                <button onClick={() => setScreen('new-shop-setup')} style={{ ...buttonStyle, background: color.ledger }}>
                  + New shop
                </button>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  {!manualCompanyId && (
                    <button onClick={() => setManualCompanyId(true)} style={faintLinkStyle}>Can't find your shop? Enter Company ID manually</button>
                  )}
                  <button onClick={() => setScreen('vendor-login')} style={faintLinkStyle}>Support Login</button>
                </div>
              </>
            )}
          </div>
        )}

        {screen === 'shop-login' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>Log in to <strong style={{ color: color.ink }}>{selectedCompanyName}</strong>.</p>
            {resetSuccessMessage && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13 }}>{resetSuccessMessage}</div>}
            <Field label="Username" innerRef={loginUsernameRef} placeholder="username" />
            <PasswordField label="Password" innerRef={loginPasswordRef} placeholder="password" />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: color.inkSoft }}>
              <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
              Remember me - skip straight to my shop next time
            </label>
            <button onClick={() => void handleLogin()} disabled={submitting} style={buttonStyle}>
              {submitting ? 'Logging in…' : 'Login'}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <button onClick={() => { setManualCompanyId(false); setScreen('shop-picker'); }} style={faintLinkStyle}>← Back</button>
              <button onClick={() => goToForgotPassword(selectedCompanyId ?? '', selectedCompanyName)} style={faintLinkStyle}>Forgot password / PIN?</button>
            </div>
          </div>
        )}

        {screen === 'forgot-password-request' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recoveryLicenseOk === null ? (
              <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>Checking this device's license…</p>
            ) : recoveryLicenseOk === false ? (
              <>
                <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13 }}>
                  This device has no active license — account recovery needs a licensed installation. Activate this device first, then try again.
                </div>
                <button onClick={() => setScreen('shop-login')} style={{ ...faintLinkStyle, marginTop: 6 }}>← Back to login</button>
              </>
            ) : !forgotRequestId ? (
              <>
                <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>
                  Submit a recovery request for <strong style={{ color: color.ink }}>{selectedCompanyName}</strong>. RaSetu support will review it and
                  send you a reset code - this needs an internet connection, both now and when you redeem the code later.
                </p>
                <Field label="Your username" innerRef={forgotUsernameRef} placeholder="username" />
                <Field label="Contact note (optional)" innerRef={forgotContactNoteRef} placeholder="e.g. your phone number, or how support can reach you" />
                <button onClick={() => void handleForgotPasswordRequest()} disabled={submitting} style={buttonStyle}>
                  {submitting ? 'Submitting…' : 'Submit request'}
                </button>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <button onClick={() => setScreen('shop-login')} style={faintLinkStyle}>← Back to login</button>
                  <button onClick={() => setScreen('forgot-password-redeem')} style={faintLinkStyle}>I already have a reset code</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13 }}>
                  Request submitted. Reference: <span style={{ fontFamily: theme.mono }}>{forgotRequestId}</span>. RaSetu support will contact you once
                  it's approved - come back here with the code they give you.
                </div>
                <button onClick={() => setScreen('forgot-password-redeem')} style={buttonStyle}>I already have a reset code</button>
                <button onClick={() => setScreen('shop-login')} style={{ ...faintLinkStyle, marginTop: 6 }}>← Back to login</button>
              </>
            )}
          </div>
        )}

        {screen === 'forgot-password-redeem' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recoveryLicenseOk === null ? (
              <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>Checking this device's license…</p>
            ) : recoveryLicenseOk === false ? (
              <>
                <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13 }}>
                  This device has no active license — account recovery needs a licensed installation. Activate this device first, then try again.
                </div>
                <button onClick={() => setScreen('shop-login')} style={{ ...faintLinkStyle, marginTop: 6 }}>← Back to login</button>
              </>
            ) : (
              <>
                <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>
                  Enter the reset code RaSetu support gave you, plus a new password for <strong style={{ color: color.ink }}>{selectedCompanyName}</strong>.
                </p>
                <Field label="Username" innerRef={redeemUsernameRef} placeholder="username" />
                <Field label="Reset code" innerRef={redeemCodeRef} placeholder="the code support gave you" />
                <PasswordField label="New password" innerRef={redeemNewPasswordRef} placeholder="min 6 characters" />
                <Field label="New 4-digit PIN (optional)" innerRef={redeemNewPinRef} placeholder="leave blank to keep your existing PIN" />
                <button onClick={() => void handleForgotPasswordRedeem()} disabled={submitting} style={buttonStyle}>
                  {submitting ? 'Resetting…' : 'Reset password'}
                </button>
                <button onClick={() => setScreen('forgot-password-request')} style={{ ...faintLinkStyle, marginTop: 6 }}>← Back</button>
              </>
            )}
          </div>
        )}

        {screen === 'new-shop-setup' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <StepIndicator step={1} total={3} label="Shop Setup" />
            <Field label="Shop name" innerRef={companyNameRef} placeholder="e.g. Shree Textiles" defaultValue={newShopDraft.name} />
            <Field label="GSTIN (optional)" innerRef={gstinRef} placeholder="22AAAAA0000A1Z5" defaultValue={newShopDraft.gstin} />
            <Field label="Address (optional)" innerRef={addressRef} placeholder="Shop address" defaultValue={newShopDraft.address} />
            <Field label="Phone (optional)" innerRef={phoneRef} placeholder="Shop phone number" defaultValue={newShopDraft.phone} />
            <Field label="Email (optional)" innerRef={emailRef} placeholder="Shop email" defaultValue={newShopDraft.email} />

            <div style={{ marginTop: 4 }}>
              <label style={{ display: 'block', fontSize: 12, color: color.inkSoft, marginBottom: 6 }}>Where should this company's data live?</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setSelectedVolumeId(null)}
                  style={{
                    textAlign: 'left', padding: '9px 12px', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13,
                    border: `1px solid ${selectedVolumeId === null ? color.brass : color.line}`,
                    background: selectedVolumeId === null ? color.brassTint : 'transparent',
                    color: color.ink,
                  }}
                >
                  This computer <span style={{ color: color.inkFaint, fontSize: 11.5 }}>(default)</span>
                </button>
                {drives.map((d) => (
                  <button
                    type="button"
                    key={d.volumeId}
                    onClick={() => setSelectedVolumeId(d.volumeId)}
                    style={{
                      textAlign: 'left', padding: '9px 12px', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13,
                      border: `1px solid ${selectedVolumeId === d.volumeId ? color.brass : color.line}`,
                      background: selectedVolumeId === d.volumeId ? color.brassTint : 'transparent',
                      color: color.ink,
                    }}
                  >
                    {d.label || `Drive ${d.driveLetter}:`} <span style={{ color: color.inkFaint, fontSize: 11.5 }}>({d.driveLetter}: - {d.isRemovable ? 'removable' : 'external'})</span>
                  </button>
                ))}
              </div>
              {selectedVolumeId !== null && (
                <p style={{ color: color.inkFaint, fontSize: 11.5, margin: '6px 0 0' }}>
                  This location is fixed once the shop is created - it can't be moved to a different drive later yet.
                </p>
              )}
            </div>

            <button onClick={handleNextFromShopSetup} style={buttonStyle}>Next: Profile Setup</button>
            {companies.length > 0 && (
              <button onClick={() => setScreen('shop-picker')} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 6 }}>← Back to login</button>
            )}
          </div>
        )}

        {screen === 'new-shop-profile' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <StepIndicator step={2} total={3} label="Profile Setup" />
            {profiles.length === 0 ? (
              <p style={{ color: color.inkFaint, fontSize: 13 }}>Loading business types…</p>
            ) : (
              <>
                <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>
                  Your business type. RaSetu ships one profile today - more business types (jewellery, electronics, hardware) arrive in a future update.
                </p>
                {profiles.map((p) => (
                  <div key={p.key} style={{ padding: '10px 12px', borderRadius: theme.radiusSm, border: `1px solid ${color.brass}`, background: color.brassTint, fontSize: 13.5, fontWeight: 600, color: color.ink }}>
                    {p.name}
                  </div>
                ))}
                <button onClick={() => handleNextFromProfile(profiles[0])} style={buttonStyle}>Next: Owner Account</button>
              </>
            )}
            <button onClick={() => setScreen('new-shop-setup')} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 6 }}>← Back</button>
          </div>
        )}

        {screen === 'new-shop-owner' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <StepIndicator step={3} total={3} label="Owner Account" />
            <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>Create your own login for {newShopDraft.name}.</p>
            <p style={{ color: color.inkFaint, fontSize: 11.5, margin: '0 0 4px' }}>
              Data will be stored on: {newShopDraft.storageVolumeId ? newShopDraft.storageLabel : 'This computer'}
            </p>
            <Field label="Your name" innerRef={adminNameRef} placeholder="Your name" defaultValue={newShopDraft.adminName} />
            <Field label="Username" innerRef={adminUsernameRef} placeholder="admin" defaultValue={newShopDraft.adminUsername} />
            <PasswordField label="Password" innerRef={adminPasswordRef} placeholder="min 6 characters" />
            <button onClick={() => void handleCreateShop()} disabled={submitting} style={buttonStyle}>
              {submitting ? 'Creating…' : 'Create Shop & Continue'}
            </button>
            <button onClick={() => setScreen('new-shop-profile')} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 6 }}>← Back</button>
          </div>
        )}

        {screen === 'set-pin' && pendingSession && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>
              {pendingSession.companyName} is set up. Set a 4-digit PIN for quick login next time - you can skip this and set it later in Settings.
            </p>
            <Field label="4-digit PIN" innerRef={setupPinRef} placeholder="1234" type="password" />
            <button onClick={() => void handleSetupPin()} disabled={submitting} style={buttonStyle}>
              {submitting ? 'Saving…' : 'Save PIN & Continue'}
            </button>
            <button onClick={() => finishOnboarding(false)} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 6 }}>Skip for now</button>
          </div>
        )}

        {screen === 'vendor-login' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ color: color.inkFaint, fontSize: 13, margin: '0 0 4px' }}>RaSetu support/vendor access - logged and audited on every company entered.</p>
            <Field label="Email" innerRef={vendorEmailRef} placeholder="vendor email" type="email" />
            <PasswordField label="Password" innerRef={vendorPasswordRef} placeholder="password" />
            <button onClick={() => void handleVendorLogin()} disabled={submitting} style={buttonStyle}>
              {submitting ? 'Logging in…' : 'Login'}
            </button>
            <button onClick={() => setScreen('shop-picker')} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 6 }}>Back</button>
          </div>
        )}

        {screen === 'vendor-console' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ background: color.amberTint, color: color.amber, padding: 10, borderRadius: theme.radiusSm, fontSize: 12.5, marginBottom: 4 }}>
              Support Console - choose a company to access. Every entry is logged.
            </div>
            {vendorCompanies.map((c) => (
              <button
                key={c.id}
                onClick={() => void handleEnterCompany(c.id)}
                disabled={submitting}
                style={{ textAlign: 'left', padding: '10px 12px', borderRadius: theme.radiusSm, border: `1px solid ${color.line}`, background: color.paper, cursor: 'pointer', fontSize: 13.5, color: color.ink }}
              >
                {c.name}{c.gstin ? <span style={{ color: color.inkFaint }}> - {c.gstin}</span> : null}
              </button>
            ))}
            <button onClick={() => { setVendorToken(null); setVendorCompanies([]); setScreen('shop-picker'); }} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 6 }}>
              Log out of vendor session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
