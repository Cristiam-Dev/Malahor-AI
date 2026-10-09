# programming/frontend/mobile

## Usar Cuando

- React Native, Expo, Flutter, iOS/Android o UI movil detectada.

## Versiones y compatibilidad

- Validar version exacta de React Native/Expo/Flutter y arquitectura nativa antes de instalar librerias.
- En Expo/RN, confirmar compatibilidad con New Architecture, Hermes y platform support.

## Reglas profesionales

- Reutilizar `specialty-mobile` como guia principal.
- Diseñar touch targets, safe areas, teclado, permisos, deep links y estados offline desde el inicio.
- Listas grandes con virtualizacion; imagenes optimizadas por densidad/tamano.
- Animaciones y gestos deben evitar bloquear el hilo JS.
- No agregar dependencias nativas sin revisar mantenimiento, permisos y soporte iOS/Android.
- Persistencia local: versionar schema y migraciones.

## Anti-patrones

- UI web trasladada sin adaptar gestos, teclado o safe areas.
- Permisos solicitados sin contexto de usuario.
- Listas largas con `ScrollView` simple.
- Dependencias nativas no verificadas.

## Validacion

- Probar en emulador/dispositivo real cuando toque nativo.
- Revisar permisos, cold start, offline/retry y build de release.
- Smoke en iOS y Android si el alcance es multiplataforma.

## Referencias oficiales

- React Native Docs: https://reactnative.dev/docs/getting-started
- Expo Docs: https://docs.expo.dev/
- Flutter Docs: https://docs.flutter.dev/
- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines/
- Material Design: https://m3.material.io/
