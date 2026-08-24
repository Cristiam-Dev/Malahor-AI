# Vision de negocio - malahor-ai

## Resumen

`malahor-ai` es una herramienta CLI para preparar cualquier proyecto de software para trabajo asistido por IA sin ensuciar el repositorio del usuario. Su foco es dar memoria persistente, contexto estructural del codigo, orquestacion de subagentes, SDD y calidad integrada a agentes como OpenCode, Claude Code, Cursor y Codex.

## Problema

Los desarrolladores que trabajan con agentes de IA pierden contexto entre sesiones, repiten decisiones, reexploran codigo de forma costosa y terminan agregando archivos de configuracion de IA dentro de repos que deberian mantenerse limpios.

## Propuesta de valor

Malahor instala un ecosistema local de IA que vive fuera del repositorio del usuario y permite que el agente recuerde decisiones, entienda la estructura del codigo, delegue tareas a subagentes y siga un flujo de especificacion antes de implementar cambios no triviales.

## Usuarios objetivo

- Desarrolladores que usan agentes de IA en proyectos personales o profesionales.
- Equipos que quieren estandarizar trabajo con IA sin contaminar repositorios de codigo.
- Tech leads que necesitan trazabilidad de decisiones, contexto y calidad en tareas asistidas por IA.
- Usuarios avanzados de OpenCode que quieren memoria, grafos y SDD integrados.

## Diferenciadores

- Cero archivos en repos del usuario.
- Memoria MCP propia: Mnemo.
- Grafos externos por proyecto usando Graphify.
- Orquestador neutral y configurable.
- SDD extendido con fase obligatoria de calidad.
- Pattern advisor antes de implementar decisiones de diseno.
- Compatible con vault markdown externo y Obsidian.

## Metricas de exito

- Instalacion funcional en WSL/Ubuntu con OpenCode.
- OpenCode arranca sin errores de configuracion MCP.
- Mnemo guarda y recupera contexto por proyecto.
- Graphify genera grafos fuera del repositorio del usuario.
- El usuario puede ejecutar un flujo SDD basico sin crear archivos en el repo objetivo.
- `malahor-ai doctor` diagnostica problemas comunes de instalacion.

## Principios de producto

- Local first: todo funciona localmente por defecto.
- Privacidad por defecto: no enviar datos a servicios externos salvo opt-in.
- Repos limpios: ningun archivo generado dentro de proyectos del usuario.
- Agnostico de agente: OpenCode primero, pero la arquitectura no debe encerrarse en un unico agente.
- Contexto minimo: entregar al agente solo lo necesario para reducir tokens.
