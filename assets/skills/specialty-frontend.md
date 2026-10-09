# specialty-frontend

Guia de especialidad para trabajo de frontend: interfaces web, SPAs y experiencia de usuario tecnica. Aplica a React/Next, Angular, Vue, Svelte y TypeScript.

## Usar Cuando

- Se crean o modifican componentes, paginas, rutas o estados de UI.
- La tarea pide React/Next, Angular, Vue o Svelte, o el stack detectado es frontend.
- Se toca accesibilidad, rendimiento percibido, formularios o integracion con APIs.
- Se ajustan estilos, temas o diseño responsivo a nivel de implementacion.

## Preguntas Guia

1. Que estado necesita el componente y de donde viene (props, servidor, usuario)?
2. Que datos cambian con el tiempo y como se sincronizan con el backend?
3. Como se manejan estados de carga, error y vacio?
4. Que interacciones de teclado y lectores de pantalla debe soportar?
5. Que se re-renderiza innecesariamente y como se evita?
6. Como se valida la entrada del usuario antes de enviarla?

## Puntos de Revision

- Estado: minimo estado local; derivar lo derivable; una sola fuente de verdad por dato.
- Rutas: rutas claras, deep links que funcionan, manejo de 404 y redirecciones.
- Formularios: validacion accesible, mensajes junto al campo, estados de envio.
- Accesibilidad: semantica correcta, foco visible, contraste suficiente, labels en controles, textos alternativos.
- Rendimiento: listas virtualizadas o paginadas, evitar trabajo en cada tecleo, dividir bundles cuando pesen.
- Responsive: fluido antes que fijo; tocar y leer en pantallas pequenas.
- Frameworks: respetar convenciones del framework detectado (Angular signals/standalone, React Server Components/Client Components, Vue/Nuxt composables, Svelte stores/runes segun version).
- Datos: separar estado de servidor de estado de UI; cachear y revalidar datos remotos con una estrategia clara.

## Anti-Patrones

- Estado duplicado entre componentes sin dueno claro.
- Efectos que sincronizan estado derivable (causan bucles y dobles renders).
- Fetch sin cancelacion, sin cache ni manejo de error.
- Cerrar elementos interactivos a clics de mouse sin soporte de teclado.
- Estilos inline o clases magicas sin un sistema de diseno.
- Reimplementar componentes que el framework o la libreria base ya provee.

## Salida

- Componentes o archivos a tocar y contrato de props/estado.
- Estados de UI a cubrir (carga, error, vacio, exito).
- Puntos de accesibilidad y rendimiento a verificar.
- Decisiones relevantes para guardar en Mnemo.

## Integracion Con SDD

- Usar dentro de `sdd-design` y `sdd-apply` para cambios de UI no triviales.
- Para cambios puramente visuales pequenos, aplicar directo sin inflar el flujo.
- Guardar decisiones de arquitectura de estado o rutas en Mnemo.
