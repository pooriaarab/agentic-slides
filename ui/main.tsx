import { StrictMode, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "agentic-design/styles.css";
import { AppShell, Button, EmptyState, Input, Select, SidebarNav, ThemeProvider, ToastProvider, TooltipProvider, useTheme, type ThemePreference } from "agentic-design/react";
import "./app.css";
import { DeckList } from "./decks.js";
import { SlidesEditor } from "./embed.js";
import { Present } from "./present.js";
import { hrefOf, useRoute } from "./route.js";
import { clearToken, clientFor, messageOf, saveToken, savedToken, type Me } from "./session.js";

function SignIn({ onToken }: { onToken: (token: string) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) return setError("Type your access token.");
    setBusy(true);
    try {
      await clientFor(token.trim()).me();
      onToken(token.trim());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signin">
      <h1>Slides</h1>
      <p className="muted">Type the access token that your administrator gave you. It names who edits. The token stays in this tab only.</p>
      <form onSubmit={submit} noValidate>
        <Input label="Access token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} error={error} />
        <Button type="submit" loading={busy}>Sign in</Button>
      </form>
    </main>
  );
}

function ThemePicker() {
  const { preference, setPreference } = useTheme();
  return (
    <Select label="Theme" hideLabel value={preference} onChange={(e) => setPreference(e.target.value as ThemePreference)}>
      <option value="system">Theme: system</option>
      <option value="light">Theme: light</option>
      <option value="dark">Theme: dark</option>
    </Select>
  );
}

function Signed({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const route = useRoute();
  const client = useMemo(() => clientFor(token), [token]);
  const [me, setMe] = useState<Me | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    client.me().then(setMe, (e) => setError(messageOf(e)));
  }, [client]);

  if (error) return <main className="signin"><EmptyState title="Could not sign in" description={error} action={<Button onClick={onSignOut}>Use another token</Button>} /></main>;
  if (!me) return <main className="signin"><p role="status" className="muted"><span className="ad-spinner" aria-hidden="true" /> Signing in…</p></main>;
  const canWrite = me.role === "editor";

  if (route.name === "present") return <Present key={route.id} client={client} id={route.id} start={route.at} />;
  return (
    <AppShell
      brand="Slides"
      sidebar={<SidebarNav label="Main" items={[{ href: hrefOf({ name: "decks" }), label: "Decks", current: route.name === "decks" }]} />}
      topbar={<><ThemePicker /><span className="muted">{me.name} ({me.role})</span><Button variant="secondary" size="sm" onClick={onSignOut}>Sign out</Button></>}
    >
      {route.name === "deck" ? <SlidesEditor key={route.id} client={client} docId={route.id} principal={{ kind: me.kind, name: me.name, role: me.role }} presence={{ token }} /> : <DeckList client={client} canWrite={canWrite} />}
    </AppShell>
  );
}

function App() {
  const [token, setToken] = useState(savedToken());
  if (!token) return <SignIn onToken={(t) => (saveToken(t), setToken(t))} />;
  return <Signed token={token} onSignOut={() => (clearToken(), setToken(null))} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
