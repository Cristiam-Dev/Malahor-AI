# programming/frontend/nextjs

## Usar Cuando

- Proyecto Next.js detectado por `next`, `next.config.*`, carpeta `app`/`pages` o despliegue Vercel/Node con Next.

## Versiones y compatibilidad

- Baseline 2026-10: Next.js App Router como ruta recomendada para nuevos desarrollos.
- `pages/` sigue existiendo en proyectos legacy; no migrar sin alcance explicito.
- Server Actions, caching y RSC cambian entre versiones: validar docs y version del proyecto.

## Reglas oficiales sintetizadas

- Server Components por defecto en App Router; usar Client Components solo para interactividad, browser APIs o hooks cliente.
- Mantener secretos, tokens y data fetching sensible en servidor.
- Definir estrategia de cache/revalidacion de forma explicita (`no-store`, revalidate, tags, path revalidation) cuando afecte frescura.
- Usar `loading.tsx`, `error.tsx`, `not-found.tsx` y boundaries por segmento para resiliencia.
- Server Actions: validar input en runtime, autorizar por recurso y devolver errores seguros.
- Metadata, images y rutas dinamicas deben tener contratos claros y fallbacks.
- Evitar waterfalls: cargar datos cerca del boundary correcto y paralelizar cuando el framework lo permita.

## Anti-patrones

- `use client` en paginas/layouts completos sin necesidad.
- Leer secretos o variables sensibles en cliente.
- Cache implicita sin entender freshness.
- Mutaciones sin validacion/autorizacion server-side.

## Validacion

- `next build` o build del proyecto.
- Smoke de rutas criticas, errores, loading y not-found.
- Revisar HTML/metadata de paginas importantes.
- Validar hidratacion cuando haya client components complejos.

## Referencias oficiales

- Next.js Docs: https://nextjs.org/docs
- App Router: https://nextjs.org/docs/app
- Rendering: https://nextjs.org/docs/app/building-your-application/rendering
- Caching: https://nextjs.org/docs/app/building-your-application/caching
- Server Actions: https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations
