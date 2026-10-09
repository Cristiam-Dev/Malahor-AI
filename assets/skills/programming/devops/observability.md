# programming/devops/observability

## Usar Cuando

- Logs, metricas, tracing, alertas, SLOs o diagnostico de produccion.

## Versiones y compatibilidad

- Baseline 2026-10: conceptos OpenTelemetry y practicas SRE.
- Elegir backend segun stack: Prometheus/Grafana, CloudWatch, Cloud Monitoring, Azure Monitor, Datadog, etc.

## Reglas oficiales/canonicas sintetizadas

- Instrumentar signals principales: logs, metrics y traces.
- Propagar contexto/correlation ID entre servicios y jobs asincronos.
- Logs estructurados con nivel, evento, request ID, actor/tenant si aplica y sin secretos/PII innecesaria.
- Metricas RED para servicios request/response: rate, errors, duration; USE para recursos: utilization, saturation, errors.
- Tracing distribuido en flujos inter-servicio y latencia critica.
- Alertas accionables basadas en sintomas/SLO, no solo causas internas ruidosas.
- Dashboards minimos: health, latencia, errores, saturacion, dependencias.

## Anti-patrones

- Logs de texto libre imposibles de consultar.
- Alertas por cada excepcion sin impacto de usuario.
- No propagar trace/request ID.
- Loggear tokens, payloads sensibles o PII completa.

## Validacion

- Generar evento de error y confirmar log/metric/trace.
- Probar dashboard y alerta critica.
- Revisar cardinalidad de etiquetas.

## Referencias oficiales/canonicas

- OpenTelemetry Concepts: https://opentelemetry.io/docs/concepts/
- Google SRE Book: https://sre.google/sre-book/table-of-contents/
- AWS Well-Architected Operational Excellence: https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html
