# specialty-mobile

Guia de especialidad para aplicaciones moviles: React Native, Expo, Flutter, iOS/Android, gestos, listas, rendimiento y distribucion.

## Usar Cuando

- La tarea toca React Native, Expo, Flutter, iOS o Android.
- Se implementan pantallas, navegacion, gestos, animaciones, listas o integraciones nativas.
- Se trabaja en rendimiento movil, permisos, notificaciones, camara, archivos o publicacion app store.
- `malahor-ai context detect` sugiere `specialty-mobile`.

## Preguntas Guia

1. Que plataformas soporta el cambio (iOS, Android, web) y que diferencias importan?
2. Que parte corre en JS/Dart y que parte depende de modulos nativos?
3. Que permisos necesita y como se explica al usuario?
4. Que listas, imagenes o animaciones pueden afectar FPS, memoria o bateria?
5. Que pasa offline, con red lenta o al volver del background?
6. Como se valida en emulador/dispositivo real y en builds de release?

## Puntos de Revision

- Navegacion: rutas tipadas o centralizadas, deep links claros, back behavior nativo.
- Listas: virtualizacion (`FlashList`, `FlatList`, listas paginadas) para colecciones grandes.
- Animaciones: usar APIs nativas/performance-friendly; evitar bloquear el hilo JS.
- Imagenes: tamanos correctos, cache, placeholders y compresion.
- Permisos: pedirlos en contexto, con fallback y mensajes claros.
- Offline: estados de reintento, cola o cache cuando el flujo lo requiera.
- New Architecture/Expo: revisar compatibilidad de librerias y versiones antes de actualizar.

## Anti-Patrones

- Usar `ScrollView` para listas grandes.
- Ejecutar logica pesada en cada render o en handlers de gesto.
- Instalar librerias nativas sin validar compatibilidad con Expo/React Native actual.
- Ignorar safe areas, teclado, notch y tamanos de pantalla.
- Probar solo en simulator/emulator sin validar un build real cuando toca nativo.
- Pedir permisos al inicio sin explicar el valor para el usuario.

## Salida

- Plataformas afectadas y dependencias nativas.
- Pantallas/rutas/componentes a tocar.
- Riesgos de rendimiento, permisos y release.
- Pruebas necesarias (unitarias, dispositivo, build, smoke).
- Decisiones relevantes para guardar en Mnemo.

## Integracion Con SDD

- Usar en `sdd-design` y `sdd-apply` cuando el cambio movil no sea trivial.
- Si hay integracion nativa o release, agregar chequeos de devops/calidad.
- Guardar decisiones de arquitectura movil o compatibilidad en Mnemo.
