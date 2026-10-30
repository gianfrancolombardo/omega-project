# Charla

Compañera de voz para una persona mayor, lúcida e inmóvil. Habla español rioplatense.
Este repositorio es el primer prototipo: una pantalla, una conversación y una memoria para una sola persona.
No es un producto clínico y no reemplaza a la familia ni a una emergencia.

## Qué hace

- La pantalla entera es un botón. Reposo, escucha, pensamiento y habla se distinguen por color, texto grande y animación.
- Ignora un toque doble accidental. Se puede interrumpir con la voz o con otro toque.
- Si nadie habla, vuelve al reposo entre 60 y 90 segundos para no dejar la llamada abierta.
- La voz usa la API Realtime de OpenAI por WebRTC. El navegador recibe una clave efímera. `OPENAI_API_KEY` no sale del servidor.
- Clara habla de adulta a adulta, hace una pregunta por vez y no usa diminutivos ni tono de guardería.
- A la hora configurada, si la tablet está encendida, saluda por el nombre y retoma el hilo de ayer. Si la persona dice que ahora no, no insiste: como mucho reintenta una vez a la media hora.
- Recuerda gustos, familia, lugares e historias. Se le puede preguntar qué sabe y se le puede decir que olvide algo.
- Al cerrar, resume la charla y anota hechos nuevos.
- Ante una emergencia o una idea de hacerse daño, pide que llamen al 911 en Uruguay y, en el caso de suicidio, también al 0800 0767. Deja una alerta. Si hay un webhook, avisa al contacto.

## Qué queda para después

Tablero familiar, historias sonoras, música, juegos de palabras, WhatsApp, palabra de activación, aplicación nativa, varios usuarios y cualquier puntaje clínico. Sin `NOTIFY_WEBHOOK_URL`, la alerta solo se guarda. Si el resumen automático falla, queda un extracto de lo dicho y no se inventan recuerdos.

Los números 911 y 0800 0767 / *0767 salen de la documentación del proyecto. Conviene confirmarlos antes de una prueba con una persona real.

## Requisitos

- Node.js 22
- Una clave de OpenAI con acceso al modelo realtime
- Para el deploy, Postgres de Supabase (connection string del Transaction pooler, puerto 6543)

## Variables

Copiá `.env.example` a `.env`.

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `OPENAI_API_KEY` | Sí, para hablar | Clave del servidor. Nunca va en el navegador. |
| `SETUP_PIN` | Sí | PIN familiar. Protege la configuración y el gasto de la voz. |
| `DATABASE_URL` | Sí en Netlify | Postgres de Supabase, puerto 6543. Sin esto, en Netlify la memoria se borra en cada deploy. |
| `OPENAI_REALTIME_MODEL` | No | Default `gpt-realtime-2.1-mini`. |
| `OPENAI_VOICE` | No | Default `marin`. También sirve `cedar`. |
| `OPENAI_VOICE_SPEED` | No | Default `0.92`. Con audición reducida baja a 0.86. |
| `OPENAI_SUMMARY_MODEL` | No | Default `gpt-5.4-mini`. Resume al cerrar. |
| `OPENAI_TRANSCRIPTION_MODEL` | No | Default `gpt-4o-mini-transcribe`. Idioma `es`. |
| `OPENAI_NOISE_REDUCTION` | No | `far_field` (default) o `near_field`. |
| `APP_TIMEZONE` | No | Default `America/Montevideo`. |
| `SILENCE_CLOSE_SECONDS` | No | Entre 60 y 90. Default 75. |
| `NOTIFY_WEBHOOK_URL` | No | POST JSON cuando hay una alerta. Vacío: solo se guarda. |
| `CHARLA_DB_PATH` | No | SQLite local. Default `data/charla.sqlite`. |

Gian tiene que cargar, como mínimo, `OPENAI_API_KEY` y `SETUP_PIN`. En Netlify, también `DATABASE_URL`. Ninguna lleva el prefijo `NEXT_PUBLIC_`: así quedan en las funciones y no en el navegador.

## Correr en la máquina

```bash
npm install
cp .env.example .env
npm run dev
```

Abrí [http://127.0.0.1:3847](http://127.0.0.1:3847). La primera vez la pantalla pide activar la tablet.

1. Entrá a `/setup`.
2. Escribí el PIN.
3. Completá el nombre, la hora y algún gusto.
4. Tocá **Activar esta tablet**.
5. Volvé a la pantalla grande y tocá el círculo.

Sin clave, la pantalla lo dice en castellano y no intenta llamar a OpenAI.

```bash
npm test
npm run lint
```

Las vistas de la interfaz, sin micrófono, están en `/?estado=reposo`, `escuchando`, `pensando`, `hablando`, `problema` e `invitacion`. Hay capturas en `docs/screenshots/`. En local abrí siempre `http://127.0.0.1:3847`: el servidor de desarrollo acepta ese origen.

El micrófono exige un contexto seguro. `localhost` y el HTTPS de Netlify sirven. Una IP de la red en `http://` no puede abrir el micrófono.

## Supabase

1. Creá un proyecto en Supabase.
2. En **Connect**, elegí **Transaction pooler** y copiá la URI. El host es `….pooler.supabase.com` y el puerto es **6543**. Esa vía es IPv4 y sirve para las funciones de Netlify. El puerto 5432 directo, en el plan gratis, es solo IPv6.
3. Pegá esa URI en `DATABASE_URL`. Si la contraseña tiene símbolos (`@`, `#`, `?`), usá la versión codificada para URL.
4. En el **SQL Editor**, ejecutá `supabase/schema.sql` una vez.
5. La app habla con la base desde el servidor, con esa URI. No usa la clave `anon`.

En local, si `DATABASE_URL` está vacío, la memoria queda en `data/charla.sqlite`.

## Deploy

`netlify.toml` ya está en el repositorio: Node 22, `npm run build` y la carpeta `.next`. Importá el repo desde Git; no hace falta cambiar el comando de build. Netlify aplica el runtime OpenNext en cada build y publica `app/api` como funciones. No instales `@netlify/plugin-nextjs` (fijarlo deja afuera las actualizaciones del runtime). Ninguna variable lleva el prefijo `NEXT_PUBLIC_`.

1. En Netlify: **Add new site** → **Import an existing project** y elegí este repositorio.
2. En **Environment variables** (alcance **Functions** y **Builds**), cargá:
   - `OPENAI_API_KEY`
   - `DATABASE_URL`: URI del Transaction pooler de Supabase (host `….pooler.supabase.com`, puerto **6543**)
   - `SETUP_PIN`
3. En el **SQL Editor** de Supabase, ejecutá `supabase/schema.sql` una vez.
4. Deploy. Si cambiás una variable después, volvé a desplegar para que las funciones la vean.
5. Abrí `https://….netlify.app` en la tablet.

## Tablet en modo kiosco

Probado como objetivo para Fully Kiosk Browser, en horizontal o vertical, con la pantalla siempre encendida.

1. Instalá Fully Kiosk Browser.
2. URL de inicio: la URL HTTPS del deploy.
3. Activá el modo kiosco, el arranque con el equipo y mantener la pantalla encendida.
4. Permití micrófono y reproducción automática.
5. Subí el volumen y el brillo. Desactivá el silencio de medios.
6. Recarga si hay error de red.
7. El PIN de administración de Fully es distinto de `SETUP_PIN`.

En la tablet, la primera vez:

1. Mantené presionada la hora de arriba unos cinco segundos. Eso abre `/setup`.
2. Entrá con el PIN, guardá la ficha y tocá **Activar esta tablet**.
3. Volvé a la charla. Un toque corto en la hora también empieza la conversación. El toque largo es solo para la familia.

La persona no tiene que escribir el PIN para hablar. La tablet lo recuerda después de activarla.

## Límites de esta versión

Una sola persona. El PIN es un secreto compartido, no una cuenta. Clara no diagnostica ni habla de medicación. Las señales de ánimo (preguntas sueltas inspiradas en UCLA-3, WHO-5 y PHQ-2) se guardan como señales, no como un puntaje clínico. Una charla guiada busca durar unos 10 a 20 minutos y propone un cierre. No está hecha para retener a nadie.
