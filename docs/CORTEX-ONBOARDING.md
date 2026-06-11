# Cortex Finance Monitor: guía de onboarding

Documento canónico para entender este fork rápido. Si solo vas a leer un
archivo, lee este. Cubre qué cambia respecto al upstream, cómo funciona el
branding, el sistema de variantes, el modelo Pro/entitlements, el setup de
desarrollo y el deploy.

Última actualización: 2026-06-11.

---

## 1. Qué es este fork

Cortex Finance Monitor es un rebrand de [World Monitor](https://github.com/koala73/worldmonitor)
(AGPL-3.0, de Elie Habib). El upstream es un dashboard de inteligencia global
multi-variante (full, tech, finance, happy, commodity, energy). Este fork:

- Construye la variante **finance** por defecto.
- Renombra la marca visible a "Cortex Finance Monitor" / "Cortex Analyst".
- Mantiene la licencia AGPL-3.0 y la atribución al upstream
  (`docs/UPSTREAM_README.md`).

El cambio funcional del fork es mínimo y vive en pocos archivos (ver seccion 6).
Casi todo el código es idéntico al upstream, por eso se puede seguir trayendo
mejoras de koala73 (ver seccion 7).

---

## 2. Cómo funciona el branding (el punto que más confunde)

El nombre que ve el usuario se fija en DOS momentos distintos. Si cambias uno y
no el otro, la marca queda inconsistente.

1. **Build-time (SEO / primera pintura).** `vite.config.ts` reescribe el
   `<title>` y los meta `og:`/`twitter:` de `index.html` con
   `VARIANT_META[finance].title` de `src/config/variant-meta.ts`. Esto es lo que
   ve un crawler o un `curl` al HTML estático.

2. **Runtime (pestaña real del navegador).** Cuando carga el JS,
   `src/App.ts` (~linea 1004) ejecuta
   `document.title = t('shell.documentTitle')`, leyendo la clave i18n
   `shell.documentTitle` de `src/locales/<idioma>.json`. Este valor **gana** y
   es el título real que ve el usuario.

   Trampa histórica: el build mostraba "Cortex" pero la app en runtime mostraba
   "World Monitor" porque las 24 traducciones de `shell.documentTitle` no se
   habían rebrandeado. Si rebrandeas, toca SIEMPRE los locales.

3. **Sub-app `/pro` (build separado).** La página de upgrade en `/pro` NO se
   construye con el build principal. Se compila desde `pro-test/` (Vite propio,
   locales propios en `pro-test/src/locales/`, y un H1 hardcodeado en
   `pro-test/prerender.mjs`). Su salida va a `public/pro/` (artefactos
   commiteados). Reconstruir: `npm run build:pro`. El `npm run build` principal
   NO regenera `/pro`.

Resumen de fuentes de marca a tocar en un rebrand:

| Capa | Fuente | Lo regenera |
| --- | --- | --- |
| Título build/SEO | `src/config/variant-meta.ts` | `npm run build` |
| Título runtime + textos UI | `src/locales/*.json` | `npm run build` |
| Strings sueltos en código | `src/**` (footer, ventanas, paneles) | `npm run build` |
| HTML estático | `index.html`, `public/offline.html`, `settings.html` | `npm run build` (copia) |
| Página `/pro` | `pro-test/**` -> `public/pro/` | `npm run build:pro` |

Lo que NO se debe tocar al rebrandear: dominios `*.worldmonitor.app` en el CSP
de `index.html` / `vercel.json` y en config (son backends en vivo: `clerk.`,
`abacus.`, `api.`); la atribución a `koala73/worldmonitor`; los comentarios de
código que describen la API original.

---

## 3. Sistema de variantes

`src/config/variant.ts` exporta `SITE_VARIANT`, que decide qué dashboard se
muestra. Orden de resolución:

1. Build: `VITE_VARIANT` (lo fija el script de build; aquí `finance`). Sin él, `full`.
2. Runtime en navegador: por subdominio (`finance.`, `tech.`, `happy.`,
   `commodity.`, `energy.`). En `localhost` o Tauri, por `localStorage`.
3. Fallback: cualquier otro hostname cae a la variante de build (finance). Esto
   es lo que hace que `cortex-finance-monitor.vercel.app` muestre finance sin
   necesitar un subdominio `finance.`.

Cada variante define sus paneles, capas de mapa y metadatos en
`src/config/panels.ts` y `src/config/variant-meta.ts`.

---

## 4. Modelo Pro / entitlements

"Pro" NO es un build aparte ni una descarga. Todos los paneles premium ya están
en el código, marcados con `premium: 'locked'` en `src/config/panels.ts`. Es un
gate en runtime.

Fuente de verdad del acceso: `src/services/panel-gating.ts` -> `hasPremiumAccess()`.
Devuelve true si se cumple cualquiera de:

1. **Clave de licencia** presente en runtime config (`WORLDMONITOR_API_KEY`),
   validada en el servidor contra `WORLDMONITOR_VALID_KEYS`
   (`api/_api-key.js`). Es la **via de self-host / operador**: la única que el
   propio código describe como "bypasses entitlement checks".
2. **Suscripción de pago** real (Convex + Dodo + Clerk) via `isProUser()`. Es la
   de worldmonitor.app; no aplica a una instancia self-host.
3. **Rol Pro** en la sesión auth, o **app de escritorio** (Tauri con clave
   enterprise).

### Cómo se desbloquea en este fork (self-host)

1. Hay una clave enterprise en la env var `WORLDMONITOR_VALID_KEYS` del proyecto
   de Vercel (producción).
2. El usuario introduce esa misma clave en el dashboard: Ajustes -> campo
   "Cortex Finance Monitor License Key". Eso activa `WORLDMONITOR_API_KEY` en el
   runtime config y `hasPremiumAccess()` pasa a true.

La clave local (la que hay que pegar en Ajustes) se guarda fuera de git en
`.pro-license-key.local` (ignorada por `.gitignore`, chmod 600). Nunca la
commitees.

### Importante: gate != datos

Desbloquear el gate hace que los paneles premium se **vean**, pero muchos (Stock
Analysis, Daily Market Brief, Cortex Analyst, AI Forecasts, Market Implications)
llaman a backends de IA/datos. En self-host necesitan tus propias API keys
(`OPENROUTER_API_KEY`, `GROQ_API_KEY`, etc.; ver `.env.example`). Sin ellas el
panel aparece pero no produce datos.

---

## 5. Setup de desarrollo

Requisitos: Node 22+ (este entorno usa Node 24 en `~/.local/node/bin`; no está
en el PATH por defecto, exporta `PATH="$HOME/.local/node/bin:$PATH"`).

```bash
npm ci                # instalar dependencias
npm run dev           # dev server, variante finance
npm run build         # build de producción -> dist/
npm run build:pro     # reconstruir SOLO la pagina /pro
```

Nota de puerto: el `npm run dev` del proyecto usa el **puerto 3000** por
defecto, que colisiona con otro proyecto local ("Denavi OS", Next.js). Para
evitar el choque, `.claude/launch.json` arranca el dev en el **puerto 5180**
(`--strictPort`). Si lanzas dev a mano, usa `npm run dev -- --port 5180`.

---

## 6. Archivos clave del rebrand (diff respecto al upstream)

- `package.json`: nombre del paquete y scripts `dev`/`build` apuntando a la
  variante finance.
- `src/config/variant.ts`: fallback a la variante de build en cualquier hostname.
- `src/config/variant-meta.ts`: bloque `finance` con branding Cortex y `url` del
  deploy.
- `src/locales/*.json`, `index.html`, `public/offline.html`, `settings.html`,
  `pro-test/**` -> `public/pro/`: strings de marca (rebrand Fase 2).

---

## 7. Sincronización con el upstream

El upstream (`koala73/worldmonitor`) es muy activo. Para traer mejoras sin perder
el rebrand:

```bash
git remote add upstream https://github.com/koala73/worldmonitor.git
git fetch upstream main
# revisar cambios y aplicar (rebase/cherry-pick); los conflictos vivirán en los
# pocos archivos de la seccion 6.
```

Como el fork toca pocos archivos, los conflictos se concentran ahí. Define una
cadencia (p. ej. mensual) y revisa el CHANGELOG del upstream antes de mergear.

---

## 8. Deploy (Vercel)

- Proyecto `cortex-finance-monitor` en el equipo **denavi**. Repo de GitHub
  conectado para auto-deploys desde `main`.
- Framework Vite, build `npm run build`, output `dist`.
- `vercel.json` tiene un "Ignored Build Step" (`scripts/vercel-ignore.sh`): los
  deploys por git que NO tocan archivos web salen "Canceled by Ignored Build
  Step". Es esperado; si un deploy legítimo se cancela, redeploy desde el
  dashboard.
- Env var obligatoria para Pro: `WORLDMONITOR_VALID_KEYS` (ya configurada en
  producción). Las API keys de datos/IA son opcionales.
- Producción: https://cortex-finance-monitor.vercel.app
