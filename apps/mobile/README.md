# apps/mobile

## What this folder is for

The employee mobile client (Expo + React Native). DOCUMENT 22 calls attendance the
most-used mobile screen in the product, which is what this application exists to serve.

## What it contains

The Expo shell: `App.tsx`, the Expo configuration, and the locale/direction wiring. No
business screens yet — the mobile surface is scheduled after the modules it would show.

## Which part of the system uses it

People, on a phone. It calls `apps/api` over HTTP.

## Important rules and dependencies

- Direction is a **style**, not a document attribute, but it is still derived from the
  locale by `@ufuq/i18n` — so web and mobile can never disagree about what Arabic means.
- The API treats a mobile session differently from a web one (`X-Client-Type: mobile`
  gets a bearer token instead of a cookie, OD-02). That is an API concern; this app only
  sends the header.

## Should developers add files here?

Only for the mobile client. Anything shared with the web app belongs in `packages/`.
Building a mobile screen for a module the API does not have yet would be placeholder UI
(RULE 26).
