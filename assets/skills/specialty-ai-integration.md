# specialty-ai-integration

Guia de especialidad para integrar IA en proyectos existentes o nuevos: RAG, LLM providers, MCP, embeddings, seguridad y costos.

## Usar Cuando

- Se agregan LLMs, RAG, embeddings o agentes a un producto.
- Se integran providers (OpenAI, Anthropic, Azure OpenAI, modelos locales) o servidores MCP.
- Se toca seguridad, costos, evaluacion u observabilidad de features de IA.
- Se adopta IA en codigo legacy o en flujos con datos sensibles.

## Preguntas Guia

1. Que problema real resuelve la IA y como se mide que funciona?
2. Que datos necesita el modelo, de donde salen y que tan frescos deben estar?
3. Que parte conviene hacer con IA y que parte con logica determinista?
4. Como se evaluan las salidas y como se detectan fallos o alucinaciones?
5. Que datos sensibles pueden llegar al modelo y como se protegen?
6. Cuanto cuesta por llamada y como se limita el abuso?

## Puntos de Revision

- RAG: chunks adecuados, retrievals evaluados, contexto limitado a lo relevante.
- Prompts: versionados, con ejemplos y restricciones claras; sin secretos dentro.
- Providers: una capa de abstraccion real (adapters) antes de cambiar de proveedor.
- Seguridad: no enviar datos personales o secretos sin consentimiento y redaccion.
- Costos: limites por usuario/sesion, cacheo de respuestas repetibles, modelos pequenos cuando basten.
- Observabilidad: registrar latencia, tokens, errores y calidad muestreada.

## Anti-Patrones

- Usar un LLM para lo que una regla o una consulta resuelve mejor y mas barato.
- Prompts gigantes sin evaluacion ni versionado.
- Confiar en salidas sin validar formato ni contenido antes de usarlas.
- Mezclar llamadas a proveedores por todo el codigo sin una sola puerta de entrada.
- Ignorar costo por llamada y limites de tasa.
- Enviar datos sensibles al modelo sin necesidad ni aviso.

## Salida

- Arquitectura propuesta: flujo, componentes de IA y no IA, puntos de integracion.
- Riesgos de seguridad, privacidad y costo, con mitigaciones.
- Como se evaluara la calidad y que metricas se miran.
- Decisiones para guardar en Mnemo.

## Integracion Con SDD

- Usar dentro de `sdd-design` y `sdd-apply` para features de IA.
- Evaluar con `pattern-advisor` antes de elegir arquitectura de RAG o agentes.
- Guardar decisiones de providers, datos y seguridad en Mnemo.
