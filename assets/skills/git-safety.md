# git-safety

Evitar perdida accidental de cambios o acciones Git destructivas.

## Antes De Modificar Git

1. Revisar `git status`.
2. Revisar `git diff`.
3. Confirmar que los archivos pertenecen al bloque actual.
4. Pedir confirmacion si hay cambios ajenos o conflicto de alcance.

## Acciones Peligrosas

- `git reset --hard`
- `git checkout -- <file>`
- `git clean`
- `git commit --amend`
- Borrado de ramas o tags.

## Regla

No ejecutar acciones locales peligrosas sin una instruccion explicita y especifica, preview del target y aprobacion propia. Las operaciones remotas no entran en este flujo: son hard DENY y ninguna confirmacion las habilita.

## Salida

- Riesgo detectado.
- Accion segura recomendada.
- Pregunta de confirmacion si aplica.
