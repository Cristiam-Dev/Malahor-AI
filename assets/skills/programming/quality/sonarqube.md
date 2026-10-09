# programming/quality/sonarqube

## Usar Cuando

- Proyecto usa SonarQube/SonarCloud/SonarQube Community Build, `sonar-project.properties` o quality gates.

## Versiones y compatibilidad

- Baseline 2026-10: documentacion SonarSource para SonarQube Community Build/Server/Cloud.
- Reglas y capacidades dependen de edicion, lenguaje y quality profile.

## Reglas oficiales sintetizadas

- Tratar Sonar como verificacion automatizada de seguridad, confiabilidad y mantenibilidad, no como sustituto de review.
- Priorizar vulnerabilities y bugs sobre code smells cosmeticos.
- Mantener Quality Gate enfocado en New Code para mejora incremental.
- No silenciar reglas sin justificar falso positivo, decision de riesgo o excepcion temporal.
- Coverage debe proteger flujos criticos; subir porcentaje sin assertions utiles no aporta.
- Exclusions deben ser minimas, documentadas y revisadas.
- Conectar IDE + servidor cuando el equipo usa Connected Mode.

## Anti-patrones

- Marcar `//NOSONAR` por comodidad.
- Cambiar quality profile global para pasar una build.
- Excluir carpetas enteras sin analisis de riesgo.
- Confundir deuda tecnica con prioridad de seguridad.

## Validacion

- Quality Gate definido y visible en CI.
- Issues nuevos triageados por severidad.
- Exclusions y suppressions justificadas.
- Reporte de cobertura y duplicacion alineado al riesgo real.

## Referencias oficiales

- SonarQube Community Build Docs: https://docs.sonarsource.com/sonarqube-community-build/
- Quality Gates: https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates/
- Project Analysis: https://docs.sonarsource.com/sonarqube-community-build/analyzing-source-code/overview/
- SonarQube Cloud: https://docs.sonarsource.com/sonarqube-cloud/
