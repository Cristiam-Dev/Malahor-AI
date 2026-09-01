# quality-coverage

Revisar cobertura de pruebas cuando el proyecto tenga herramienta configurada.

## Pasos

1. Detectar si existe script de cobertura.
2. Ejecutar cobertura solo si el comando esta disponible.
3. Revisar archivos modificados con baja cobertura.
4. Priorizar pruebas sobre comportamiento nuevo o riesgoso.
5. Reportar si no hay infraestructura de cobertura.

## Indicadores

- Cobertura baja en ramas criticas.
- Codigo nuevo sin pruebas.
- Tests que verifican implementacion interna en vez de comportamiento.
- Snapshots amplios sin aserciones utiles.

## Salida

- Herramienta o script usado.
- Resultado de cobertura.
- Brechas importantes.
- Pruebas recomendadas.
