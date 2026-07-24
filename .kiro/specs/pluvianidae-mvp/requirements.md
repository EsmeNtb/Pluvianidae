# Requirements Document

## Introduction

Pluvianidae es un asistente inteligente integrado en el flujo de desarrollo que comprende repositorios de código, facilita la navegación semántica, detecta problemas antes del commit y conecta frontend con backend. El MVP se enfoca en proyectos JavaScript/TypeScript con React, Node.js y Express, ofreciendo búsqueda inteligente, mapa de referencias, detección de código no utilizado, revisión pre-commit, conexión frontend-backend, generación de README y un sistema gamificado de semillas para presentar hallazgos.

## Glossary

- **Sistema**: La aplicación Pluvianidae en su totalidad
- **Indexador**: Módulo encargado de analizar y construir el índice del repositorio (archivos, funciones, componentes, imports, exports, endpoints)
- **Buscador**: Módulo que procesa consultas en lenguaje natural y devuelve resultados relevantes del repositorio indexado
- **Analizador_De_Referencias**: Módulo que identifica definiciones, importaciones, usos y dependencias de símbolos del código
- **Detector_De_Codigo_No_Utilizado**: Módulo que identifica imports, variables, parámetros, funciones sin uso, archivos huérfanos y código comentado o duplicado
- **Comparador_Frontend_Backend**: Módulo que analiza endpoints del backend y llamadas HTTP del frontend para detectar incompatibilidades
- **Revisor_Pre_Commit**: Módulo que ejecuta verificaciones automáticas antes de un commit
- **Generador_De_README**: Módulo que analiza el repositorio y produce o actualiza documentación README
- **Motor_De_Semillas**: Módulo que genera, almacena y presenta hallazgos como semillas con estados de ciclo de vida
- **Mascota**: Elemento visual animado (pájaro) que comunica estados del sistema al usuario
- **Semilla**: Unidad de hallazgo que representa una recomendación, tip, problema encontrado o review pendiente
- **Repositorio_Objetivo**: El repositorio JavaScript/TypeScript que el usuario desea analizar
- **Amazon_Bedrock**: Servicio de AWS utilizado para interpretar consultas en lenguaje natural, explicar código y generar resúmenes
- **Usuario**: Persona desarrolladora que interactúa con Pluvianidae

## Requirements

### Requirement 1: Indexación del repositorio

**User Story:** Como desarrollador, quiero que Pluvianidae indexe automáticamente mi repositorio JavaScript/TypeScript, para poder realizar búsquedas y análisis sobre el código.

#### Acceptance Criteria

1. WHEN el Usuario abre un Repositorio_Objetivo, THE Indexador SHALL analizar todos los archivos con extensiones .js, .jsx, .ts y .tsx del Repositorio_Objetivo, excluyendo la carpeta node_modules y las carpetas de dependencias (bower_components, .pnp)
2. WHEN el Indexador procesa un archivo, THE Indexador SHALL extraer funciones, componentes, clases, imports, exports y endpoints definidos en el archivo
3. WHEN el Repositorio_Objetivo contiene un archivo .gitignore, THE Indexador SHALL excluir los archivos y carpetas listados en .gitignore del proceso de indexación
4. THE Indexador SHALL excluir del proceso de indexación los archivos que coincidan con los siguientes patrones: .env, .env.*, *.pem, *.key, *.cert, *.p12, credentials.json, *secret* y archivos dentro de carpetas nombradas .ssh o .aws
5. WHILE el Indexador procesa el Repositorio_Objetivo, THE Sistema SHALL mostrar al Usuario el número de archivos procesados sobre el total de archivos detectados y el nombre del archivo en procesamiento actual
6. IF el Indexador encuentra un archivo con errores de sintaxis, THEN THE Indexador SHALL registrar el error indicando el nombre del archivo y la descripción del error, y continuar procesando los archivos restantes
7. WHEN un archivo con extensión .js, .jsx, .ts o .tsx es creado, modificado o eliminado en el Repositorio_Objetivo después de la indexación inicial, THE Indexador SHALL actualizar el índice procesando únicamente los archivos afectados, con un objetivo de tiempo de 5 segundos por archivo; IF la actualización no se completa dentro de 5 segundos, THEN THE Indexador SHALL continuar el procesamiento hasta completar la actualización del índice

### Requirement 2: Búsqueda inteligente del repositorio

**User Story:** Como desarrollador, quiero buscar código usando lenguaje natural, para encontrar funciones, archivos o implementaciones sin conocer nombres exactos.

#### Acceptance Criteria

1. WHEN el Usuario envía una consulta en lenguaje natural, THE Buscador SHALL enviar la consulta a Amazon_Bedrock para interpretación semántica junto con el índice del Repositorio_Objetivo como contexto
2. WHEN el Buscador obtiene resultados, THE Buscador SHALL mostrar para cada resultado: nombre del archivo, ruta completa, nombre de la función o componente, fragmento de código relevante (máximo 20 líneas) y una breve explicación generada por Amazon_Bedrock
3. WHEN el Buscador obtiene resultados, THE Buscador SHALL mostrar archivos relacionados con cada resultado basándose en las relaciones de importación y dependencia del índice
4. WHEN el Usuario envía una consulta, THE Buscador SHALL sugerir consultas alternativas junto con los resultados para ayudar al Usuario a descubrir mejores términos de búsqueda; IF no existen coincidencias, THEN THE Buscador SHALL informar al Usuario que no se encontraron resultados y mostrar las sugerencias alternativas de forma destacada
5. WHEN el Usuario envía una consulta, THE Buscador SHALL devolver resultados en un tiempo máximo de 5 segundos
6. IF Amazon_Bedrock no está disponible o no responde dentro de 10 segundos, THEN THE Buscador SHALL informar al Usuario que el servicio de búsqueda semántica no está disponible y ofrecer una búsqueda por texto exacto como alternativa

### Requirement 3: Mapa de referencias

**User Story:** Como desarrollador, quiero ver el mapa completo de referencias de una función, componente o clase, para entender cómo se conecta con el resto del código.

#### Acceptance Criteria

1. WHEN el Usuario selecciona un símbolo (función, componente, clase o endpoint), THE Analizador_De_Referencias SHALL mostrar dónde se define el símbolo incluyendo archivo y número de línea
2. WHEN el Usuario selecciona un símbolo, THE Analizador_De_Referencias SHALL mostrar todos los archivos donde se importa el símbolo con la ruta completa y número de línea de cada importación
3. WHEN el Usuario selecciona un símbolo, THE Analizador_De_Referencias SHALL mostrar todos los lugares donde se utiliza el símbolo indicando archivo, línea y contexto de uso
4. WHEN el Usuario selecciona una función, THE Analizador_De_Referencias SHALL mostrar las funciones que invoca directamente (primer nivel de profundidad)
5. WHEN el Usuario selecciona un símbolo, THE Analizador_De_Referencias SHALL mostrar los archivos que dependen del símbolo seleccionado como una lista de dependientes directos
6. IF el Usuario selecciona un símbolo que no se encuentra en el índice del Repositorio_Objetivo, THEN THE Analizador_De_Referencias SHALL informar al Usuario que el símbolo no fue encontrado e indicar posibles causas (archivo no indexado, símbolo externo a una dependencia)

### Requirement 4: Detección de código no utilizado

**User Story:** Como desarrollador, quiero que Pluvianidae detecte código que no está siendo utilizado, para mantener limpio y mantenible mi repositorio.

#### Acceptance Criteria

1. WHEN el Usuario solicita un análisis de código no utilizado, THE Detector_De_Codigo_No_Utilizado SHALL identificar imports no utilizados, variables no utilizadas, parámetros no utilizados, funciones no invocadas y archivos huérfanos (archivos que no son importados ni referenciados por ningún otro archivo del Repositorio_Objetivo), y SHALL completar el análisis en un tiempo máximo de 60 segundos
2. WHEN el Detector_De_Codigo_No_Utilizado identifica un hallazgo, THE Detector_De_Codigo_No_Utilizado SHALL reportar para cada hallazgo: nivel de confianza (alto: sin ninguna referencia en el proyecto; medio: referenciado solo en código comentado o tests; bajo: referenciado de forma dinámica o indirecta), ubicación exacta (archivo y línea), explicación del problema y acción sugerida (eliminar, comentar o revisar manualmente)
3. WHEN el Detector_De_Codigo_No_Utilizado identifica un bloque de 3 o más líneas consecutivas comentadas o un bloque de 5 o más líneas duplicadas con al menos 80% de similitud respecto a otro bloque en el Repositorio_Objetivo, THE Detector_De_Codigo_No_Utilizado SHALL incluir el hallazgo como advertencia separada de los hallazgos principales, con nivel de confianza "bajo"
4. THE Detector_De_Codigo_No_Utilizado SHALL presentar las correcciones automáticas como propuestas y solicitar confirmación del Usuario antes de aplicar cambios
5. IF el Detector_De_Codigo_No_Utilizado encuentra un archivo con errores de sintaxis durante el análisis, THEN THE Detector_De_Codigo_No_Utilizado SHALL registrar el archivo como no analizable, informar al Usuario y continuar el análisis con los archivos restantes

### Requirement 5: Conexión frontend-backend

**User Story:** Como desarrollador, quiero detectar incompatibilidades entre el frontend y el backend, para prevenir errores de integración antes de que lleguen a producción.

#### Acceptance Criteria

1. WHEN el Usuario solicita un análisis de conexión frontend-backend, THE Comparador_Frontend_Backend SHALL analizar del backend: rutas, métodos HTTP, parámetros esperados, body esperado, respuestas y tipos de datos
2. WHEN el Usuario solicita un análisis de conexión frontend-backend, THE Comparador_Frontend_Backend SHALL analizar del frontend: servicios HTTP, hooks, componentes con llamadas API, formularios, tipos y variables de entorno
3. WHEN el Comparador_Frontend_Backend detecta un endpoint del backend sin consumidor en el frontend, THE Comparador_Frontend_Backend SHALL reportar el endpoint como no consumido indicando la ruta, el método HTTP y la ubicación de la definición (archivo y línea); THE Comparador_Frontend_Backend SHALL almacenar internamente los resultados de detección independientemente de si la notificación al Usuario es exitosa
4. WHEN el Comparador_Frontend_Backend detecta una llamada del frontend sin endpoint correspondiente en el backend, THE Comparador_Frontend_Backend SHALL reportar la llamada como sin endpoint indicando la URL invocada, el método HTTP y la ubicación de la llamada (archivo y línea)
5. WHEN el Comparador_Frontend_Backend detecta tipos incompatibles entre una llamada del frontend y un endpoint del backend, THE Comparador_Frontend_Backend SHALL reportar la incompatibilidad indicando los tipos esperados por el backend, los tipos enviados o consumidos por el frontend, y la ubicación de ambos (archivo y línea)
6. WHEN el Comparador_Frontend_Backend detecta diferencias en métodos HTTP, rutas incorrectas o campos faltantes, THE Comparador_Frontend_Backend SHALL reportar cada discrepancia indicando archivo y línea de origen, la categoría de la discrepancia y una descripción del conflicto
7. IF el Comparador_Frontend_Backend no puede analizar un archivo del frontend o del backend por errores de sintaxis u otros fallos de parseo, THEN THE Comparador_Frontend_Backend SHALL registrar el archivo no analizable con la razón del fallo y continuar el análisis con los archivos restantes

### Requirement 6: Revisión previa al commit

**User Story:** Como desarrollador, quiero que Pluvianidae realice una revisión completa antes de hacer commit, para evitar subir código con errores o problemas de calidad.

#### Acceptance Criteria

1. WHEN el Usuario inicia una revisión pre-commit, THE Revisor_Pre_Commit SHALL analizar los archivos incluidos en el staging area de git y ejecutar las siguientes verificaciones: linter, pruebas unitarias, errores de compilación, imports rotos (referencias a módulos o archivos inexistentes), archivos olvidados (archivos nuevos no incluidos en el staging area), posibles secretos o credenciales (cadenas que coincidan con patrones de API keys, tokens, contraseñas en texto plano o claves privadas) y código no utilizado
2. WHEN el Revisor_Pre_Commit completa la revisión, THE Revisor_Pre_Commit SHALL generar un reporte que clasifique cada hallazgo como error (problemas que impiden compilación o ejecución correcta), advertencia (problemas de calidad que no impiden ejecución) o recomendación (mejoras opcionales), e incluya para cada hallazgo: tipo de verificación que lo originó, ubicación (archivo y línea), descripción del problema, y un resumen de los archivos incluidos en el commit
3. WHEN el Revisor_Pre_Commit detecta posibles secretos o credenciales en los archivos del staging area, THE Revisor_Pre_Commit SHALL impedir que el commit se ejecute automáticamente, omitir el resumen del reporte y mostrar al Usuario una advertencia con la ubicación de cada secreto detectado, requiriendo acción explícita del Usuario para continuar o cancelar; IF el sistema de detección de secretos produce falsos positivos o errores de escaneo, THEN THE Revisor_Pre_Commit SHALL mostrar una advertencia al Usuario y requerir acción explícita para continuar o cancelar
4. IF el Revisor_Pre_Commit no puede ejecutar alguna verificación (linter no configurado, pruebas ausentes, compilador no disponible), THEN THE Revisor_Pre_Commit SHALL incluir en el reporte una entrada indicando el nombre de la verificación omitida y el motivo por el cual no pudo ejecutarse, y continuar con las verificaciones restantes
5. WHEN el Usuario inicia una revisión pre-commit, THE Revisor_Pre_Commit SHALL completar todas las verificaciones en un tiempo máximo de 60 segundos; IF el tiempo se excede, THEN THE Revisor_Pre_Commit SHALL presentar los resultados parciales obtenidos hasta ese momento e informar al Usuario qué verificaciones no se completaron

### Requirement 7: Generación y actualización de README

**User Story:** Como desarrollador, quiero que Pluvianidae genere o actualice el README de mi proyecto, para mantener la documentación al día sin esfuerzo manual.

#### Acceptance Criteria

1. WHEN el Usuario solicita la generación del README, THE Generador_De_README SHALL analizar el Repositorio_Objetivo y producir un borrador con un objetivo de tiempo de 30 segundos; IF el análisis requiere más tiempo, THEN THE Generador_De_README SHALL continuar la generación hasta completar el borrador y entregar el resultado completo al Usuario, incluyendo: descripción del proyecto, stack tecnológico, instrucciones de instalación, variables de entorno requeridas, scripts disponibles, estructura de carpetas, endpoints principales e instrucciones para ejecutar frontend y backend
2. WHEN el Generador_De_README produce un borrador, THE Generador_De_README SHALL mostrar el borrador al Usuario como propuesta y solicitar confirmación antes de escribir el archivo
3. IF el Usuario rechaza el borrador propuesto, THEN THE Generador_De_README SHALL descartar el borrador, preservar el README existente sin modificaciones y no escribir ningún archivo
4. WHEN el Repositorio_Objetivo ya contiene un README, THE Generador_De_README SHALL mostrar las diferencias entre el README existente y el borrador propuesto como parte de la propuesta de confirmación
5. IF el Generador_De_README no encuentra información en el Repositorio_Objetivo para alguna sección del borrador (endpoints, variables de entorno u otra), THEN THE Generador_De_README SHALL omitir dicha sección del borrador e indicar al Usuario qué secciones no pudieron generarse
6. THE Generador_De_README SHALL utilizar Amazon_Bedrock para generar descripciones en lenguaje natural y resúmenes del proyecto basados en el contenido analizado del Repositorio_Objetivo
7. WHEN el Usuario acepta el borrador propuesto, THE Generador_De_README SHALL mostrar opciones de ubicación del archivo y solicitar confirmación final del Usuario antes de escribir el archivo en disco

### Requirement 8: Explicación del repositorio

**User Story:** Como desarrollador que ingresa a un proyecto desconocido, quiero recibir una explicación general del repositorio, para entender rápidamente su estructura y tecnologías.

#### Acceptance Criteria

1. WHEN el Usuario abre un Repositorio_Objetivo que no ha sido explicado previamente en la sesión actual, THE Sistema SHALL generar en un máximo de 15 segundos una explicación del repositorio que incluya: stack del frontend (si existe), stack del backend (si existe), principales dependencias identificadas y flujo principal de la aplicación
2. WHEN el Sistema genera la explicación del repositorio, THE Sistema SHALL utilizar Amazon_Bedrock para producir descripciones del flujo principal que incluyan los pasos secuenciales desde la acción inicial del usuario hasta la respuesta del sistema
3. WHEN el Usuario solicita una explicación actualizada, THE Sistema SHALL regenerar la explicación comparando el estado actual del Repositorio_Objetivo con el estado al momento de la última explicación generada, e indicando qué secciones cambiaron
4. IF el Repositorio_Objetivo no contiene código de frontend o de backend identificable, THEN THE Sistema SHALL generar la explicación incluyendo únicamente las secciones aplicables e indicar al Usuario qué secciones no fueron detectadas; THE Sistema SHALL permitir la generación de la explicación incluso si la indicación de secciones faltantes falla
5. IF Amazon_Bedrock no está disponible o no responde dentro de 10 segundos durante la generación de la explicación, THEN THE Sistema SHALL informar al Usuario que la explicación no pudo generarse y ofrecer la opción de reintentar, independientemente del estado de otras funcionalidades del Sistema

### Requirement 9: Sistema de semillas

**User Story:** Como desarrollador, quiero recibir hallazgos y recomendaciones representados como semillas, para gestionar fácilmente las tareas pendientes derivadas del análisis.

#### Acceptance Criteria

1. WHEN el Sistema genera un hallazgo (recomendación, tip del repositorio, problema encontrado o review pendiente), THE Motor_De_Semillas SHALL crear una Semilla con estado inicial "Pendiente" que incluya: tipo de hallazgo, módulo de origen, ubicación en el código (archivo y línea cuando aplique), descripción del hallazgo y fecha de creación
2. THE Motor_De_Semillas SHALL mantener cada Semilla en uno de los siguientes estados: Pendiente, En revisión, Resuelta o Ignorada
3. WHEN el Usuario marca una Semilla como "En revisión", THE Motor_De_Semillas SHALL actualizar el estado de la Semilla a "En revisión"
4. WHEN el Usuario resuelve una Semilla, THE Motor_De_Semillas SHALL actualizar el estado de la Semilla a "Resuelta", y WHEN el Usuario ignora una Semilla, THE Motor_De_Semillas SHALL actualizar el estado de la Semilla a "Ignorada", siendo las transiciones válidas: Pendiente a En revisión, Pendiente a Resuelta, Pendiente a Ignorada, En revisión a Resuelta, y En revisión a Ignorada
5. THE Sistema SHALL mostrar el cesto visual de semillas en todo momento, indicando la cantidad total de semillas pendientes (incluyendo "0 semillas pendientes" cuando no existan) y permitiendo al Usuario ver la lista de semillas sin navegación adicional
6. WHILE existen semillas con estado "Pendiente" AND la cantidad de semillas pendientes es mayor que cero, THE Mascota SHALL mostrar una semilla visualmente para indicar hallazgos disponibles
7. WHEN el Usuario selecciona una Semilla del cesto, THE Motor_De_Semillas SHALL mostrar el detalle completo del hallazgo asociado incluyendo su descripción, ubicación en el código y acción sugerida

### Requirement 10: Mascota y guía visual

**User Story:** Como desarrollador, quiero una mascota visual (pájaro) que me comunique el estado del sistema de forma amigable, para mantener mi motivación y atención durante sesiones largas de programación.

#### Acceptance Criteria

1. THE Mascota SHALL aparecer en una esquina de la interfaz sin superponer contenido editable ni controles interactivos del Usuario
2. WHEN el Sistema completa un análisis, THE Mascota SHALL reaccionar con una animación indicando la finalización, con una duración máxima de 3 segundos antes de volver al estado inactivo
3. WHEN el Motor_De_Semillas genera una nueva Semilla, THE Mascota SHALL mostrar visualmente que lleva una semilla
4. WHEN el Detector_De_Codigo_No_Utilizado o el Revisor_Pre_Commit detectan un problema en un archivo, THE Mascota SHALL posarse visualmente junto al nombre del archivo problemático en el explorador de archivos o en la pestaña del editor correspondiente
5. WHEN el Revisor_Pre_Commit completa una revisión sin errores, THE Mascota SHALL ejecutar una animación de celebración con una duración máxima de 3 segundos antes de volver al estado inactivo
6. WHEN el Usuario solicita explícitamente ocultar la Mascota, THE Mascota SHALL ocultarse de la interfaz y el Sistema SHALL mostrar un control persistente que permita al Usuario restaurar la visibilidad de la Mascota; THE Mascota SHALL no ocultarse proactivamente en ninguna situación sin solicitud explícita del Usuario
7. IF la Mascota recibe múltiples eventos del Sistema simultáneamente, THEN THE Mascota SHALL procesar las animaciones en orden de llegada, mostrando cada una secuencialmente sin omitir eventos

### Requirement 11: Seguridad y privacidad

**User Story:** Como desarrollador, quiero que Pluvianidae maneje mi código de forma segura, para proteger información sensible y mantener control sobre mis archivos.

#### Acceptance Criteria

1. THE Sistema SHALL excluir de todos los procesos de análisis los archivos que coincidan con los siguientes patrones: archivos .env (incluyendo .env.local, .env.*, env.example con valores), archivos con extensiones .pem, .key, .p12, .pfx, .keystore, y archivos nombrados credentials.json, *_credentials.json o service-account*.json
2. THE Sistema SHALL permitir al Usuario configurar archivos y carpetas adicionales que deben ser excluidos del análisis mediante patrones glob
3. WHEN el Sistema va a enviar información a Amazon_Bedrock, THE Sistema SHALL mostrar al Usuario los nombres de archivos y fragmentos de código que serán transmitidos y requerir confirmación obligatoria del Usuario antes de ejecutar la transmisión; la transmisión no podrá proceder sin dicha confirmación
4. IF el Usuario rechaza la transmisión a Amazon_Bedrock tras la previsualización, THEN THE Sistema SHALL cancelar la transmisión sin enviar datos y mantener el estado previo de la operación
5. THE Sistema SHALL reemplazar valores sensibles (tokens, contraseñas, claves API, cadenas de conexión) con un indicador de redacción en todos los reportes generados, de forma que el valor original no sea visible ni parcialmente reconstruible
6. WHEN el Sistema va a modificar cualquier archivo del Repositorio_Objetivo, THE Sistema SHALL mostrar los cambios propuestos y solicitar confirmación del Usuario antes de aplicar la modificación
7. THE Sistema SHALL no persistir código fuente del Repositorio_Objetivo en disco ni en almacenamiento externo más allá de la sesión de análisis activa en ningún momento, salvo que el Usuario otorgue consentimiento explícito para almacenamiento persistente
