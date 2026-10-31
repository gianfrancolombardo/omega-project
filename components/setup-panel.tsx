"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DEVICE_PIN_STORAGE_KEY, FACT_CATEGORY_OPTIONS, SETUP_PIN_STORAGE_KEY } from "@/lib/copy";
import type { AlertRecord, Fact, FactCategory, FactSource, Microgoal, Profile } from "@/lib/domain";
import { metricsToCsv, type SessionMetrics } from "@/lib/metrics/csv";
import { activateTabletFeedback, saveProfileFeedback, type ActionFeedback } from "@/lib/setup/feedback";

type Snapshot = {
  profile: Profile;
  facts: Fact[];
  alerts: AlertRecord[];
  metrics: SessionMetrics[];
  microgoals: Microgoal[];
  persistenceWarning: string | null;
};

const fieldClass = "h-14 px-4 text-lg md:text-lg";

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  return fallback;
}

function factOrigin(source: FactSource): string {
  return source === "setup" ? "Cargado en la ficha" : "Guardado de una charla";
}

function factWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-UY", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function StatusNote(props: { feedback: ActionFeedback | null; id: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!props.feedback) return;
    ref.current?.focus();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [props.feedback]);
  if (!props.feedback) return null;
  return (
    <p
      ref={ref}
      id={props.id}
      tabIndex={-1}
      role={props.feedback.tone === "error" ? "alert" : "status"}
      aria-live={props.feedback.tone === "error" ? "assertive" : "polite"}
      data-tone={props.feedback.tone}
      className="charla-feedback"
    >
      {props.feedback.message}
    </p>
  );
}

export function SetupPanel() {
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<ActionFeedback | null>(null);
  const [tabletFeedback, setTabletFeedback] = useState<ActionFeedback | null>(null);
  const [category, setCategory] = useState<FactCategory>("gusto");
  const [factText, setFactText] = useState("");
  const [wipe, setWipe] = useState("");

  async function load(nextPin: string): Promise<void> {
    setLoading(true);
    setError("");
    const response = await fetch("/api/setup", { headers: { "x-setup-pin": nextPin } });
    const body: unknown = await response.json();
    setLoading(false);
    if (!response.ok) {
      setUnlocked(false);
      setError(messageOf(body, "No pude abrir la configuración."));
      return;
    }
    window.sessionStorage.setItem(SETUP_PIN_STORAGE_KEY, nextPin);
    setPin(nextPin);
    setUnlocked(true);
    setSnapshot(body as Snapshot);
  }

  useEffect(() => {
    const stored = window.sessionStorage.getItem(SETUP_PIN_STORAGE_KEY);
    if (!stored) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/setup", { headers: { "x-setup-pin": stored } });
      const body: unknown = await response.json();
      if (cancelled) return;
      if (!response.ok) {
        setError(messageOf(body, "No pude abrir la configuración."));
        return;
      }
      setPin(stored);
      setUnlocked(true);
      setSnapshot(body as Snapshot);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveProfile(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!snapshot || saving) return;
    setNotice("");
    setError("");
    setProfileFeedback(null);
    setSaving(true);
    const { profile } = snapshot;
    try {
      const response = await fetch("/api/setup", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-setup-pin": pin },
        body: JSON.stringify({
          displayName: profile.displayName,
          addressForm: profile.addressForm,
          timezone: profile.timezone,
          dailyTime: profile.dailyTime,
          proactiveEnabled: profile.proactiveEnabled,
          tastes: profile.tastes,
          lifeNotes: profile.lifeNotes,
          avoidTopics: profile.avoidTopics,
          importantPeople: profile.importantPeople,
          emergencyName: profile.emergencyName,
          emergencyPhone: profile.emergencyPhone,
          emergencyRelation: profile.emergencyRelation,
          reducedHearing: profile.reducedHearing,
          subtitles: profile.subtitles,
          rememberEnabled: !profile.memoryDeclinedAt,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      const feedback = saveProfileFeedback({
        networkError: false,
        status: response.status,
        serverMessage: messageOf(body, "") || null,
      });
      if (feedback.tone === "success" && body && typeof body === "object" && "profile" in body) {
        const next = (body as { profile?: Profile }).profile;
        if (next) setSnapshot((current) => (current ? { ...current, profile: next } : current));
      }
      setProfileFeedback(feedback);
    } catch {
      setProfileFeedback(saveProfileFeedback({ networkError: true, status: null, serverMessage: null }));
    } finally {
      setSaving(false);
    }
  }

  function patchProfile(patch: Partial<Profile>): void {
    setSnapshot((current) => (current ? { ...current, profile: { ...current.profile, ...patch } } : current));
  }

  async function addFact(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-setup-pin": pin },
      body: JSON.stringify({ action: "add_fact", category, content: factText }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      setError(messageOf(body, "No pude guardar el recuerdo."));
      return;
    }
    setFactText("");
    setNotice("Guardé el recuerdo.");
    await load(pin);
  }

  async function deleteFact(id: string): Promise<void> {
    setError("");
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-setup-pin": pin },
      body: JSON.stringify({ action: "delete_fact", id }),
    });
    if (!response.ok) {
      const body: unknown = await response.json();
      setError(messageOf(body, "No pude borrar el recuerdo."));
      return;
    }
    await load(pin);
  }

  async function clearMemory(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-setup-pin": pin },
      body: JSON.stringify({ action: "clear_memory", confirm: wipe }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      setError(messageOf(body, "No pude borrar la memoria."));
      return;
    }
    setWipe("");
    setNotice("Borré la memoria de las charlas. El nombre y la ficha familiar siguen.");
    await load(pin);
  }

  function downloadCsv(): void {
    if (!snapshot) return;
    const blob = new Blob([metricsToCsv(snapshot.metrics)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "charla-metricas.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function activateTablet(): Promise<void> {
    if (activating) return;
    setNotice("");
    setError("");
    setTabletFeedback(null);
    setActivating(true);
    try {
      const response = await fetch("/api/setup", { headers: { "x-setup-pin": pin } });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setTabletFeedback(
          activateTabletFeedback({
            networkError: false,
            status: response.status,
            serverMessage: messageOf(body, "") || null,
            storageError: false,
          }),
        );
        return;
      }
      try {
        window.localStorage.setItem(DEVICE_PIN_STORAGE_KEY, pin);
      } catch {
        setTabletFeedback(
          activateTabletFeedback({ networkError: false, status: 200, serverMessage: null, storageError: true }),
        );
        return;
      }
      setTabletFeedback(
        activateTabletFeedback({ networkError: false, status: 200, serverMessage: null, storageError: false }),
      );
    } catch {
      setTabletFeedback(activateTabletFeedback({ networkError: true, status: null, serverMessage: null, storageError: false }));
    } finally {
      setActivating(false);
    }
  }

  if (!unlocked || !snapshot) {
    return (
      <main className="charla-setup">
        <Card className="mx-auto max-w-lg">
          <CardHeader>
            <CardTitle className="text-3xl">Configuración de Charla</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void load(pin);
              }}
            >
              <Label htmlFor="pin" className="text-lg">
                PIN familiar
              </Label>
              <Input
                id="pin"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                className={fieldClass}
              />
              {error ? <p className="text-lg text-red-800">{error}</p> : null}
              {loading ? <p className="text-lg">Abriendo la ficha…</p> : null}
              <Button type="submit" className="h-14 text-lg">
                Entrar
              </Button>
              <Link className="text-lg underline" href="/">
                Volver a la charla
              </Link>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  const profile = snapshot.profile;
  return (
    <main className="charla-setup">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-4xl font-bold">Ficha de Charla</h1>
            <p className="mt-2 text-lg">Una sola persona. Lo que escribas acá lo usa Clara en la voz.</p>
          </div>
          <Link className="text-lg underline" href="/">
            Volver a la charla
          </Link>
        </header>
        {snapshot.persistenceWarning ? (
          <p className="rounded-xl bg-amber-100 px-4 py-3 text-lg">{snapshot.persistenceWarning}</p>
        ) : null}
        {notice ? <p className="text-lg">{notice}</p> : null}
        {error ? <p className="text-lg text-red-800">{error}</p> : null}

        <form onSubmit={(event) => void saveProfile(event)} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Persona</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Label htmlFor="name" className="text-lg">Nombre</Label>
              <Input id="name" value={profile.displayName} onChange={(event) => patchProfile({ displayName: event.target.value })} className={fieldClass} />
              <Label htmlFor="form" className="text-lg">Trato</Label>
              <select id="form" className="h-14 rounded-lg border px-3 text-lg" value={profile.addressForm} onChange={(event) => patchProfile({ addressForm: event.target.value === "usted" ? "usted" : "vos" })}>
                <option value="vos">Vos</option>
                <option value="usted">Usted</option>
              </select>
              <label className="flex items-center gap-3 text-lg">
                <input type="checkbox" checked={profile.reducedHearing} onChange={(event) => patchProfile({ reducedHearing: event.target.checked })} className="size-6" />
                Hablar más despacio
              </label>
              <label className="flex items-center gap-3 text-lg">
                <input type="checkbox" checked={profile.subtitles} onChange={(event) => patchProfile({ subtitles: event.target.checked })} className="size-6" />
                Mostrar subtítulos
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Horario</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Label htmlFor="time" className="text-lg">Hora de la charla del día</Label>
              <Input id="time" type="time" value={profile.dailyTime} onChange={(event) => patchProfile({ dailyTime: event.target.value })} className={fieldClass} />
              <Label htmlFor="zone" className="text-lg">Zona horaria</Label>
              <Input id="zone" value={profile.timezone} onChange={(event) => patchProfile({ timezone: event.target.value })} className={fieldClass} />
              <label className="flex items-center gap-3 text-lg">
                <input type="checkbox" checked={profile.proactiveEnabled} onChange={(event) => patchProfile({ proactiveEnabled: event.target.checked })} className="size-6" />
                Que Clara salude a esa hora
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Vida</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Label htmlFor="people" className="text-lg">Familia y personas</Label>
              <Textarea id="people" value={profile.importantPeople} onChange={(event) => patchProfile({ importantPeople: event.target.value })} className="min-h-28 text-lg md:text-lg" />
              <Label htmlFor="tastes" className="text-lg">Gustos</Label>
              <Textarea id="tastes" value={profile.tastes} onChange={(event) => patchProfile({ tastes: event.target.value })} className="min-h-28 text-lg md:text-lg" />
              <Label htmlFor="life" className="text-lg">Notas de vida</Label>
              <Textarea id="life" value={profile.lifeNotes} onChange={(event) => patchProfile({ lifeNotes: event.target.value })} className="min-h-28 text-lg md:text-lg" />
              <Label htmlFor="avoid" className="text-lg">Temas que no hay que sacar</Label>
              <Textarea id="avoid" value={profile.avoidTopics} onChange={(event) => patchProfile({ avoidTopics: event.target.value })} className="min-h-24 text-lg md:text-lg" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Emergencia</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Label htmlFor="ename" className="text-lg">Nombre del contacto</Label>
              <Input id="ename" value={profile.emergencyName} onChange={(event) => patchProfile({ emergencyName: event.target.value })} className={fieldClass} />
              <Label htmlFor="erel" className="text-lg">Vínculo</Label>
              <Input id="erel" value={profile.emergencyRelation} onChange={(event) => patchProfile({ emergencyRelation: event.target.value })} className={fieldClass} />
              <Label htmlFor="ephone" className="text-lg">Teléfono</Label>
              <Input id="ephone" value={profile.emergencyPhone} onChange={(event) => patchProfile({ emergencyPhone: event.target.value })} className={fieldClass} />
            </CardContent>
          </Card>

          <Button
            type="submit"
            className="h-14 text-lg disabled:opacity-90"
            disabled={saving}
            aria-busy={saving}
            aria-describedby={profileFeedback ? "profile-feedback" : undefined}
          >
            {saving ? "Guardando la ficha…" : "Guardar ficha"}
          </Button>
          <StatusNote id="profile-feedback" feedback={profileFeedback} />
        </form>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Memoria</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-lg">
              Clara anota sola los gustos, las personas, las fechas y los datos de la vida cotidiana que aparecen en las charlas. La persona no tiene que pedirle que guarde nada. No guarda pastillas ni diagnósticos. Si algo está mal, borralo acá.
            </p>
            <label className="flex items-center gap-3 text-lg">
              <input
                type="checkbox"
                checked={Boolean(profile.memoryDeclinedAt)}
                onChange={(event) =>
                  patchProfile({ memoryDeclinedAt: event.target.checked ? new Date().toISOString() : null })
                }
                className="size-6"
              />
              No quiere que Clara recuerde
            </label>
            {snapshot.facts.length === 0 ? <p className="text-lg">Todavía no hay recuerdos guardados.</p> : null}
            <ul className="flex flex-col gap-3">
              {snapshot.facts.map((fact) => {
                const label = FACT_CATEGORY_OPTIONS.find((item) => item.value === fact.category)?.label ?? fact.category;
                const when = factWhen(fact.updatedAt || fact.createdAt);
                return (
                  <li key={fact.id} className="flex items-start justify-between gap-3 text-lg">
                    <span>
                      <strong>{label}.</strong> {fact.content}
                      <span className="mt-1 block text-base text-[#3f3428]">
                        {factOrigin(fact.source)}
                        {when ? ` · ${when}` : ""}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-12 text-base"
                      aria-label={`Borrar recuerdo: ${fact.content}`}
                      onClick={() => void deleteFact(fact.id)}
                    >
                      Borrar
                    </Button>
                  </li>
                );
              })}
            </ul>
            <form onSubmit={(event) => void addFact(event)} className="flex flex-col gap-3">
              <Label htmlFor="category" className="text-lg">Nuevo recuerdo</Label>
              <select id="category" className="h-14 rounded-lg border px-3 text-lg" value={category} onChange={(event) => setCategory(event.target.value as FactCategory)}>
                {FACT_CATEGORY_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
              <Textarea value={factText} onChange={(event) => setFactText(event.target.value)} className="min-h-24 text-lg md:text-lg" placeholder="Le gusta el tango de Troilo" />
              <Button type="submit" className="h-14 text-lg">Agregar recuerdo</Button>
            </form>
            {snapshot.microgoals.length ? (
              <div>
                <h3 className="text-xl font-semibold">Micro-metas abiertas</h3>
                <ul className="mt-2 list-disc pl-6 text-lg">
                  {snapshot.microgoals.map((goal) => (
                    <li key={goal.id}>{goal.content}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-lg">No hay micro-metas abiertas.</p>
            )}
            <form onSubmit={(event) => void clearMemory(event)} className="flex flex-col gap-3 border-t pt-4">
              <Label htmlFor="wipe" className="text-lg">Borrar charlas, recuerdos y alertas</Label>
              <Input id="wipe" value={wipe} onChange={(event) => setWipe(event.target.value)} placeholder="Escribí BORRAR" className={fieldClass} />
              <Button type="submit" variant="destructive" className="h-14 text-lg" disabled={wipe !== "BORRAR"}>
                Borrar memoria
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Alertas</CardTitle>
          </CardHeader>
          <CardContent>
            {snapshot.alerts.length === 0 ? <p className="text-lg">No hay alertas.</p> : null}
            <ul className="flex flex-col gap-3">
              {snapshot.alerts.map((alert) => (
                <li key={alert.id} className="text-lg">
                  <strong>Nivel {alert.level} · {alert.kind}.</strong> {alert.reason} {alert.notifyDetail}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Charlas</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {snapshot.metrics.length === 0 ? <p className="text-lg">Todavía no hay charlas registradas.</p> : null}
            <ul className="flex flex-col gap-2 text-lg">
              {snapshot.metrics.map((row) => (
                <li key={row.id}>
                  {row.startedAt.slice(0, 16).replace("T", " ")} · {row.module} · {row.status}
                  {row.durationSeconds != null ? ` · ${Math.round(row.durationSeconds / 60)} min` : ""}
                  {row.costUsd != null ? ` · USD ${row.costUsd.toFixed(4)}` : ""}
                  {row.talkRatio != null ? ` · habla ${row.talkRatio}` : ""}
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" className="h-14 text-lg" onClick={downloadCsv}>
              Descargar métricas
            </Button>
          </CardContent>
        </Card>

        <Button
          type="button"
          className="h-16 text-xl disabled:opacity-90"
          onClick={() => void activateTablet()}
          disabled={activating}
          aria-busy={activating}
          aria-describedby={tabletFeedback ? "tablet-feedback" : undefined}
        >
          {activating ? "Activando esta tablet…" : "Activar esta tablet"}
        </Button>
        <StatusNote id="tablet-feedback" feedback={tabletFeedback} />
      </div>
    </main>
  );
}
