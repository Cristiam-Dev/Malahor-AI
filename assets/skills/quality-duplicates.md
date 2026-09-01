# quality-duplicates

Detectar duplicacion, complejidad accidental y abstracciones innecesarias.

## Pasos

1. Revisar archivos modificados.
2. Buscar bloques repetidos o variaciones casi identicas.
3. Distinguir duplicacion tolerable de abstraccion prematura.
4. Revisar nombres, responsabilidades y tamanos de funciones.
5. Recomendar refactor solo si reduce riesgo real.

## Alertas

- Misma regla de negocio copiada en varios lugares.
- Helpers creados para un solo caso sin claridad.
- Condicionales extensos con variantes de comportamiento.
- Funciones que mezclan IO, validacion y reglas de dominio.

## Salida

- Duplicados encontrados.
- Complejidad introducida.
- Refactors recomendados.
- Casos donde conviene no abstraer todavia.
