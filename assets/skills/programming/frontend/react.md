# programming/frontend/react

## Usar Cuando

- Proyecto React, Vite React, Remix, Next client components o libreria de componentes con hooks.

## Versiones y compatibilidad

- Baseline 2026-10: React moderno segun `react.dev`.
- React Server Components dependen del framework; no asumirlos en React puro/Vite.
- React Compiler puede reducir memoizacion manual en proyectos que lo tengan habilitado; validar config real.

## Reglas oficiales sintetizadas

- Componentes como funciones puras: mismo input, mismo output; side effects fuera del render.
- Estado minimo: calcular durante render todo lo derivable de props/estado.
- `useEffect` es escape hatch para sincronizar con sistemas externos; no usarlo para derivar estado o manejar eventos.
- Lifting state up cuando dos componentes necesitan sincronizacion; evitar duplicar fuentes de verdad.
- Hooks personalizados cuando encapsulan comportamiento reutilizable real, no por esconder complejidad local.
- Server state separado del estado de UI: usar cache/query layer o framework data APIs cuando exista.
- Accesibilidad por defecto: semantica HTML, labels, foco, teclado y estados ARIA solo cuando semantica nativa no basta.
- Rendimiento con evidencia: medir antes de `memo`, `useMemo`, `useCallback`; virtualizar listas grandes.

## Anti-patrones

- `useEffect` para recalcular valores derivados.
- Context global como store universal.
- Fetch ad hoc sin cancelacion, cache, errores ni estados.
- Componentes enormes con demasiadas responsabilidades.
- Memoizacion defensiva que complica lectura sin beneficio medido.

## Validacion

- Tests de comportamiento con Testing Library o herramienta equivalente.
- Verificar loading/error/empty/success.
- Navegacion por teclado y screen reader smoke test en componentes interactivos.
- Build de produccion para detectar errores de bundling/hidratacion si aplica.

## Referencias oficiales

- React Learn: https://react.dev/learn
- You Might Not Need an Effect: https://react.dev/learn/you-might-not-need-an-effect
- Keeping Components Pure: https://react.dev/learn/keeping-components-pure
- State Structure: https://react.dev/learn/choosing-the-state-structure
- React API Reference: https://react.dev/reference/react
