# quality-sonarqube

Preparar cambios para revision con SonarQube o reglas equivalentes de calidad estatica.

## Pasos

1. Revisar bugs probables: nulls, errores no manejados, ramas imposibles.
2. Revisar code smells: complejidad, nombres ambiguos, funciones largas.
3. Revisar seguridad: secretos, inputs no validados, comandos shell inseguros.
4. Revisar mantenibilidad: duplicacion, acoplamiento y deuda nueva.
5. Revisar cobertura esperada sobre codigo nuevo.

## No Hacer

- No silenciar reglas sin justificar.
- No agregar comentarios para ocultar codigo confuso.
- No introducir `any`, casts amplios o ignores sin necesidad real.
- No marcar calidad como aprobada si quedan fallos reproducibles.

## Salida

- Riesgos tipo bug.
- Riesgos tipo code smell.
- Riesgos de seguridad.
- Brechas de cobertura.
- Estado recomendado para `sdd-verify`.
