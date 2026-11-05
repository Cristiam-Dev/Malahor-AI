# Revisión de arquitectura y patrones

Analiza una aplicación o un flujo de código y decide qué técnicas de diseño, principios SOLID y estructura de capas aplicar para simplificar lógica con muchos condicionales, decisiones secuenciales, funciones gigantes o código difícil de mantener. Úsala antes de un plan con impacto estructural, al elegir un patrón, al revisar capas o dependencias, o cuando el repositorio sea demasiado grande para leerlo completo. Entrega evidencia concreta con `archivo:línea` y no impongas abstracciones que el problema no exige.

## Relación con Malahor

Esta skill es un **manual de decisión**, no un segundo sistema de intervención. El modo efectivo de Malahor manda:

- `acompanar`: solo diagnóstico conceptual. Sin pasos de implementación ni ejecución.
- `guiar`: diagnóstico y plan de refactor. No se ejecutan cambios.
- `ejecutar`: diagnóstico y plan. La aplicación se hace dentro de `malahor_plan`, con las ediciones y gates autorizados; no se edita directamente fuera de ese cauce.

No sustituye a `pattern-advisor`: esta skill revisa la estructura, las capas y la razón de cambio; `pattern-advisor` elige el patrón más simple cuando hace falta uno. Si el problema no necesita patrón, dilo con claridad.

No dejes documentación técnica, informes, ADRs, notas de arquitectura ni archivos de estado dentro del repositorio. El análisis vive en la respuesta. Si la persona pide conservarlo, usa la documentación canónica externa mediante `docs_*`, nunca el repositorio.

## Contrato de intervención

**Permitido**

- Analizar código, leer archivos y ejecutar lecturas o heurísticas de solo lectura.
- Proponer diagnóstico, alternativas y un plan de pasos pequeños.
- Aplicar cambios solo dentro de un plan aprobado, con las ediciones autorizadas y las pruebas que correspondan.

**Prohibido**

- Crear documentación técnica, informes, ADRs, `docs/*.md`, README nuevos o comentarios de bloque que expliquen el análisis dentro del repositorio.
- Dejar archivos temporales, scripts auxiliares o salidas del análisis dentro del árbol del proyecto.
- Hacer commit, push o cambiar de rama sin una orden explícita.
- Añadir dependencias, cambiar la API pública o modificar configuración de build, lint o CI sin autorización expresa.
- Mezclar un refactor con un cambio de comportamiento no declarado.

## Parámetros

Fíjalos al inicio, deduciéndolos de la petición. Pregunta solo lo que no puedas inferir, y como máximo una cosa a la vez.

| Parámetro | Valores | Por defecto |
|---|---|---|
| Alcance | un flujo, un módulo, toda la app | el flujo señalado; si no, el punto caliente principal |
| Objetivo | menos anidamiento, facilitar variantes, testabilidad, partir un archivo grande | el que mejor explique el dolor |
| Modo | `acompanar`, `guiar`, `ejecutar` | el modo efectivo de Malahor |
| Restricciones | API pública intocable, sin dependencias nuevas, convenciones y versión del repo | respetar siempre el repo |
| Stack | el detectado en el reconocimiento | — |

## Paso 1: reconocimiento barato

No leas el repositorio entero. Empieza por la forma y los puntos calientes:

1. Identifica el stack y la forma del proyecto: manifiesto de dependencias, árbol de carpetas a dos o tres niveles y puntos de entrada.
2. Busca señales de complejidad: archivos de más de 300 líneas, condicionales anidados, cadenas largas de `else if`, funciones con más de cuatro parámetros y nombres genéricos como `utils`, `helper`, `manager` o `process`.
3. Elige uno a tres puntos calientes, empezando por el que más duele o más cambia. Un flujo bien analizado vale más que diez revisados por encima.

Si el proyecto tiene un detector de puntos calientes, úsalo como lectura. Si no, obtén las mismas señales con lecturas dirigidas y `grep`. La heurística sirve para elegir por dónde empezar, no como veredicto.

## Paso 2: árbol de decisiones

Antes de proponer nada, escribe el flujo como lo que realmente es: un árbol de decisiones. Para cada decisión, clasifica qué tipo es:

| Tipo | Pregunta que lo delata |
|---|---|
| Guarda o validación | ¿Si falla, corta el flujo? |
| Selección de variante | ¿Elige un comportamiento según un tipo, rol o método? |
| Dependiente de estado | ¿Lo permitido depende de la etapa actual de la entidad? |
| Regla de negocio combinable | ¿Son condiciones que se combinan con y/o y cambian con el negocio? |
| Propagación de errores | ¿El condicional solo revisa si el paso anterior falló? |
| Orquestación | ¿Coordina pasos que podrían vivir en funciones separadas? |
| Efecto externo | ¿Toca base de datos, red, disco, tiempo o un tercero? |

La mezcla de tipos en un mismo bloque es el problema real. Separarlos ya resuelve media complejidad.

## Paso 3: técnica mínima

Sube un peldaño solo si el anterior no basta:

1. **Guard clauses**: retornos tempranos; quitan anidamiento sin crear nada nuevo.
2. **Extraer funciones con nombre de negocio**: el nombre reemplaza al comentario.
3. **Mapa o tabla de despacho**: reemplaza `if/else` o `switch` sobre un mismo valor.
4. **Strategy**: cada variante tiene lógica o dependencias propias y se esperan variantes nuevas.
5. **State o máquina de estados**: las transiciones válidas dependen del estado actual.
6. **Pipeline o cadena de responsabilidad**: pasos secuenciales donde cada uno valida, transforma o corta.
7. **Result o Either**: los condicionales solo existen para propagar fallos esperados.
8. **Specification**: reglas de negocio que se combinan, cambian seguido y se reutilizan.

Regla de proporción: si hay dos o tres condiciones simples y estables, la respuesta correcta es “esto no necesita un patrón, solo guard clauses”. Decirlo con claridad es parte del trabajo.

Señales de sobreingeniería: una interfaz con una sola implementación y sin variantes previstas; más andamiaje que lógica real; para entender un flujo simple hay que abrir cinco archivos; el equipo no reconoce el patrón y nadie lo documentó; se abstrae algo que todavía no cambió ni una vez.

## Paso 4: SOLID y capas con evidencia

No recites SOLID. Revisa solo lo que el código realmente viole y cita dónde:

- **S, responsabilidad única**: ¿puedes describir la unidad sin usar “y”? ¿Cuántas razones distintas hay para editarla?
- **O, abierto/cerrado**: ¿agregar una variante obliga a editar un `switch` o una cadena de `if` en varios lugares? Si nunca hubo una segunda variante, no lo declares.
- **L, sustitución de Liskov**: ¿hay subclases que lanzan “no implementado”, ignoran parámetros o exigen precondiciones más fuertes? ¿Hay chequeos de tipo después de recibir una abstracción?
- **I, segregación de interfaces**: ¿hay interfaces grandes donde cada consumidor usa una fracción? ¿Implementaciones con métodos vacíos solo para cumplir el contrato?
- **D, inversión de dependencias**: ¿la lógica de negocio crea clientes HTTP, repositorios o lee entorno directamente? Si probar una regla exige infraestructura, la regla depende de detalles.

**Capas y dirección de dependencias**

Modelo mínimo útil, adaptable al framework:

```text
Entrada (controlador, componente, ruta)
   ↓ llama a
Casos de uso o servicios de aplicación
   ↓ usan
Dominio (reglas puras, sin framework ni IO)
   ↑ definen contratos que implementan
Infraestructura (BD, HTTP externo, colas, archivos)
```

Revisa si el dominio importa infraestructura o framework, si la entrada contiene reglas de negocio, si hay dependencias circulares y si las reglas importantes se pueden probar sin levantar el framework. No impongas arquitectura hexagonal o limpia completa a un proyecto pequeño: recomienda el mínimo de capas que resuelva el dolor observado.

**Separar por razón de cambio**

- Cambian juntos, viven juntos.
- Cambian por motivos distintos, se separan: regla de negocio, integración externa, formato de salida.
- Parte por dominio antes que por tipo técnico: `pagos/` antes que `services/`, `utils/` o `helpers/`.
- El límite de un archivo es la cohesión, no el número de líneas.
- Un nombre que cuesta ponerlo señala un límite mal trazado.

**Chequeos rápidos de acoplamiento**

- Feature envy: un método usa más datos de otro objeto que de los suyos.
- Parámetros en racimo: los mismos tres o cuatro parámetros viajan juntos.
- Banderas booleanas como parámetro: suelen ocultar dos comportamientos.
- Cadenas de llamadas que atraviesan varios objetos: el cliente conoce demasiado.
- Estado global o singleton mutable: dificulta pruebas y vuelve impredecible el orden.

## Paso 5: informe

El análisis se presenta en la respuesta, no en un archivo del repositorio. Usa esta estructura:

```markdown
# Revisión de arquitectura

## Estado
- Fecha:
- Flujos analizados:
- Pendientes priorizados:

## Flujo: <nombre>
**Dónde vive:** `ruta/archivo.ts:línea`
**Problema en una frase:**
**Árbol de decisiones:** (resumen)
**Clasificación:** guardas / variantes / estado / ...
**Técnica recomendada y por qué:**
**Lo que NO conviene hacer (sobreingeniería evitada):**
**Plan de refactor (pasos pequeños):**
1. ...
**Riesgos y pruebas necesarias:**
```

Cada hallazgo debe apuntar a código concreto. Un consejo de arquitectura sin evidencia no sirve a quien tiene que aplicarlo.

## Paso 6: aplicación dentro de Malahor

Cuando el modo sea `ejecutar` y la persona pida aplicar el refactor:

1. **Red de seguridad primero.** Si el flujo no tiene pruebas, escribe pruebas de caracterización que fijen el comportamiento actual antes de refactorizar. Si no es posible probarlo, dilo y avanza con más cuidado.
2. **Un paso, un propósito.** Cada paso se entiende, se prueba y se revierte por separado. No mezcles refactor con cambio de comportamiento.
3. **Verifica después de cada paso.** Ejecuta las pruebas, el compilador y el lint disponibles. Si algo falla, corrige o revierte ese paso antes de seguir.
4. **El comportamiento observable no cambia.** Mismas entradas, mismas salidas, mismos efectos. Si descubres un bug existente, repórtalo y no lo arregles dentro del refactor sin avisar.
5. **Respeta el repo.** Nombres, carpetas, estilo y librerías ya usadas. No introduzcas un patrón que el equipo no use si una solución local más simple alcanza.
6. **Sin rastro del análisis en el código.** No dejes comentarios del tipo “refactorizado con Strategy” ni archivos que expliquen el cambio.
7. **Cierra con un resumen:** qué se cambió, por qué se eligió esa técnica, qué pruebas lo respaldan y qué queda pendiente.

## Puente a la fase 2: arquitectura y autorización

Antes de un plan con impacto estructural, produce y declara:

- mapa de módulos y capas afectadas;
- dirección de las dependencias que se introducen o cambian;
- razón de cambio de cada unidad;
- decisión explícita: **“respeta la arquitectura”** o **“cambia la arquitectura”**;
- evidencia concreta con `archivo:línea`.

Si la decisión es “cambia”, trátalo como riesgo de arquitectura y pide una autorización específica antes de implementar. El contrato de arquitectura por proyecto y el gate runtime que valida esa decisión pertenecen a la fase 2; esta skill prepara la evidencia, no la sustituye.

## Errores frecuentes

- Proponer Strategy o State para dos o tres casos que no van a crecer.
- Dividir por tipo técnico en vez de por dominio o razón de cambio.
- Recomendar una reescritura grande cuando existe un camino incremental.
- Afirmar que algo viola Open/Closed sin mostrar el cambio concreto que hoy obliga a editar código estable.
- Llenar el informe de teoría. Cada línea debe servir para decidir o actuar.
- Dejar documentación técnica, informes o notas dentro del repositorio.
- Cambiar comportamiento mientras se refactoriza, o refactorizar sin pruebas que lo respalden.
- Ocultar incertidumbre: si algo no se pudo verificar, dilo.
