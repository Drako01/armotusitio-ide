# Plan para incorporar el Harness genérico a ArmotuSitio IDE

Fecha: 29 de octubre de 2026.

Estado: plan de implementación; ninguna etapa se considera ejecutada por la creación de este documento.

## Objetivo

Distribuir un Harness propio junto al IDE, configurable por proyecto y utilizable sin instalar RedEvent.

Cualquier usuario debe poder abrir un proyecto, revisar su configuración y ejecutar tareas con seguimiento real.

El motor debe conservar planificación, validación, recuperación y evidencias sin depender del negocio de RedEvent.

La próxima publicación debe incluir esta capacidad terminada y verificada antes de ejecutar el release.

## Situación comprobada

- La base local es VS Code `1.144.0`; la configuración de distribución prepara `ats-v1.144.0-r1`.
- `extensions/armotusitio-ide` ya ofrece interfaz, seguimiento, controles de tareas y selección de proveedor.
- `src/adapter.ts` de esa extensión reconoce entradas concretas de RedEvent y ArmotuSitio.
- El contrato actual exige capacidades nativas y reconoce `armotusitio-harness-ide`, esquema 1 y versión mayor 1.
- En RedEvent, `.harness/core.mjs` delega a `.harness/bootstrap.mjs`.
- Ese bootstrap inicia `.harness/cli.py` mediante un runtime Python resuelto por el proyecto.
- El motor actual no se puede distribuir suponiendo que basta con copiar un script Node.
- El usuario informó que el último release falló; todavía no se investigó aquí su causa.

Referencias de la extensión: `src/adapter.ts`, `src/workflow.ts`, `src/provider.ts` y `src/catalog.ts`.

El estado histórico del Harness global no sustituye la comprobación de la rama y los archivos actuales.

## Límites y condiciones

- GitHub Actions debe permanecer deshabilitado bajo cualquier circunstancia durante este trabajo.
- No activar workflows, despachar ejecuciones ni modificar la configuración de Actions para obtener validación.
- Antes de cada publicación remota, comprobar que Actions continúa deshabilitado; fallar si no se puede confirmar.
- Implementar en una rama propia y llevar el resultado a `main` mediante las protecciones vigentes.
- El release final lo ejecuta el usuario; no compilar ni publicar instaladores como efecto de crear este plan.
- No modificar RedEvent ni ArmotuSitio para poder usar el motor nuevo en otros proyectos.
- No copiar credenciales, tareas, lecciones privadas, logs, historiales ni configuraciones operativas de RedEvent.
- Conservar identidad, temas, perfiles, Open VSX, servidores WSL, actualizador y claves de la distribución.
- No incorporar servicios pagos ni iniciar sesiones de IA reales sin autorización del usuario.
- No prometer compatibilidad universal: cada comando depende de herramientas y capacidades verificables del proyecto.

## Resultado esperado para la próxima publicación

La instalación del IDE contiene el motor genérico y las piezas necesarias para iniciarlo en los destinos soportados.

El usuario puede preparar un proyecto sin conexiones a Work Management, GitHub ni servicios de RedEvent.

La ejecución con IA requiere configurar un proveedor compatible con las credenciales del propio usuario.

Planificación local, estado y validaciones disponibles no deben exigir una cuenta paga de IA.

Los proyectos con un Harness propio continúan utilizando su autoridad y estado existentes.

## Arquitectura prevista

| Componente | Responsabilidad | Límite |
| --- | --- | --- |
| Motor genérico | Planes, tareas, ejecución, estados, evidencias y recuperación | Sin reglas de negocio ni rutas de RedEvent |
| Contrato versionado | Operaciones, capacidades, eventos, errores y compatibilidad | Sin inferir capacidades por nombre de proyecto |
| Configuración del proyecto | Comandos revisados, dominios, políticas y herramientas | Sin secretos versionados ni ejecución al detectar archivos |
| Adaptadores | Proveedores de ejecución y sistemas externos | Opcionales; errores aislados y capacidades explícitas |
| Extensión existente | Configuración, revisión y operación desde el IDE | Reutilizar sus vistas y servicios; evitar otra interfaz paralela |
| Distribución | Recursos, runtimes, licencias y versiones reproducibles | Sin depender del checkout del desarrollador |

La ubicación candidata del motor es `extensions/armotusitio-ide/harness/`, como recurso propio de la extensión.

Confirmar esa ubicación contra el empaquetado existente antes de crear carpetas o modificar el build.

Cada versión del IDE debe empaquetar una versión concreta del motor y de su contrato compatible.

Las primeras actualizaciones del motor viajan con el IDE; no agregar un segundo actualizador independiente.

### Motor y runtimes

Separar la lógica reutilizable de Python antes de decidir una reescritura.

Comparar extracción con Python distribuido y portabilidad a TypeScript mediante un prototipo acotado.

La decisión debe considerar tamaño, licencias, mantenimiento, arranque, empaquetado y cobertura de comportamiento.

Elegir una implementación para la primera entrega; no mantener dos motores equivalentes sin necesidad demostrada.

El resultado distribuido debe funcionar en una máquina sin el entorno de desarrollo del mantenedor.

No depender de `node`, `python`, paquetes globales o rutas del sistema sin resolverlos y diagnosticarlos explícitamente.

Ejecutar procesos fuera del renderer, con argumentos estructurados y gestión explícita de su ciclo de vida.

### Proyecto y persistencia

Proponer un archivo versionable de configuración y un directorio local de estado con nombres y esquema documentados.

Verificar colisiones con `.harness` y con configuraciones existentes antes de fijar sus nombres.

Separar configuración compartida, preferencias personales, credenciales y estado de ejecución.

Usar almacenamiento de secretos del IDE o mecanismos del proveedor; nunca el manifiesto compartido del proyecto.

Persistir estados mediante escrituras atómicas y locks con identidad de proceso e intento.

Una marca persistida de tarea activa no demuestra que el proceso siga vivo.

Definir migraciones de esquema, recuperación y comportamiento ante versiones incompatibles.

### Compatibilidad con los Harness existentes

Preservar las entradas actuales de RedEvent y ArmotuSitio y sus contratos válidos.

Detectar capacidades mediante handshake; no ejecutar una operación que el productor no anuncie.

Si cambia el contrato, negociar versiones o agregar un adaptador, sin romper silenciosamente la versión 1.

Con un Harness nativo existente, no inicializar automáticamente otro motor ni duplicar tareas o estado.

Mostrar qué motor controla el proyecto y por qué se seleccionó.

## Experiencia de uso

1. Abrir un proyecto y detectar si ya tiene un Harness compatible, sin ejecutar comandos.
1. Si no tiene, ofrecer configurar el Harness incluido en el IDE.
1. Mostrar herramientas detectadas, archivos propuestos y límites de las capacidades disponibles.
1. Revisar comandos, directorios de trabajo, proveedor y política de aprobación antes de guardar.
1. Crear únicamente los archivos aprobados, con vista previa y sin sobrescribir contenido existente.
1. Ejecutar un diagnóstico local que no inicie consultas a modelos ni servicios externos.
1. Crear una tarea y revisar preguntas, alcance, dependencias y plan antes de autorizar la ejecución.
1. Mostrar progreso, evidencias, errores y estado real de cada intento.
1. Permitir cancelar y recuperar trabajo según las capacidades efectivas del motor.

La detección de scripts o configuraciones sirve como sugerencia; no otorga permiso para ejecutarlos.

En proyectos sin Git, permitir diagnóstico y tareas locales; deshabilitar funciones que requieran ramas o worktrees.

En ventanas con varias raíces, aislar configuración, autorización, tareas y preferencias por proyecto.

## Funciones de la primera entrega

- Diagnóstico de entorno y configuración con errores accionables.
- Creación y seguimiento de tareas, planes revisables e historial por intento.
- Ejecución de verificaciones del proyecto sin IA.
- Ejecución con proveedores compatibles, configurados explícitamente por el usuario.
- Dependencias entre pasos y concurrencia limitada cuando existan unidades independientes.
- Cancelación cooperativa y terminación controlada del árbol de procesos propio cuando corresponda.
- Recuperación tras cierre, fallo o reinicio, sin duplicar ejecuciones ni asumir que es seguro reintentarlas.
- Reutilización de evidencias solo cuando sus entradas y condiciones relevantes no cambiaron.
- Exportación acotada y redactada de evidencias para diagnóstico.
- Compatibilidad con los flujos nativos actuales de RedEvent y ArmotuSitio.

La coordinación de workers requiere soporte real del proveedor; configurar concurrencia no demuestra paralelismo.

La pausa y la continuidad con el IDE cerrado solo se anuncian si existen mecanismos y pruebas que las respalden.

Quedan fuera de la primera entrega una nube propia, un marketplace de motores y la sincronización remota de secretos.

## Seguridad y control de ejecución

- Respetar Workspace Trust antes de leer configuraciones sensibles o permitir mutaciones.
- Distinguir diagnóstico, modificación de archivos, ejecución de comandos y llamadas a proveedores externos.
- Vincular la aprobación al plan y a la configuración revisados; invalidarla si cambian.
- No aceptar comandos arbitrarios provenientes de mensajes de la webview.
- Validar rutas reales, enlaces y directorios de trabajo contra la raíz autorizada.
- Usar comandos y argumentos estructurados; aislar y revisar cualquier caso que requiera un shell.
- Acotar salida, tamaño de archivos, concurrencia, tiempo de ejecución y consumo configurables.
- Redactar secretos en UI, exportaciones y logs sin registrar los valores originales como evidencia.
- Tratar la salida de herramientas y el contenido del repositorio como datos, sin ampliar permisos por su contenido.
- No hacer commit, push, merge, despliegue o limpieza destructiva por el solo hecho de iniciar una tarea.
- No trasladar las políticas de aprobación, reglas de negocio o excepciones privadas de RedEvent a todos los usuarios.

## Etapas de implementación

### Etapa 0: diagnosticar el release fallido y fijar la base

- [ ] Identificar el comando, commit, etapa y log originales del fallo, antes de volver a ejecutar el release.
- [ ] Verificar si quedaron locks, procesos, borradores o artefactos parciales; no limpiarlos automáticamente.
- [ ] Distinguir errores de entorno, empaquetado, firma, validación y publicación.
- [ ] Registrar una corrección concreta y su verificación sin habilitar Actions ni publicar el IDE.
- [ ] Crear la rama de implementación desde una base comprobada y conservar el trabajo ajeno.

Salida: causa del fallo identificada, restricciones registradas y entorno reproducible para continuar.

### Etapa 1: inventario y frontera de extracción

- [ ] Revisar módulos, contrato, pruebas y dependencias del Harness actual de RedEvent.
- [ ] Clasificar cada módulo: núcleo reutilizable, adaptador de proyecto, integración externa o dato privado.
- [ ] Identificar código distribuible, atribuciones, dependencias y condiciones de redistribución.
- [ ] Enumerar comportamientos que deben preservarse y limitaciones existentes que no deben anunciarse como resueltas.
- [ ] Definir la matriz de compatibilidad con productores nativos y versiones de estado.

Salida: mapa de extracción y contrato propuesto, sin copiar configuraciones ni estado productivo.

### Etapa 2: prototipo de runtime y distribución

- [ ] Probar la estrategia de runtime en un proyecto temporal sin herramientas globales implícitas.
- [ ] Medir tamaño, arranque y cierre; documentar diferencias por plataforma sin inventar presupuestos.
- [ ] Validar recursos de extensión, rutas con espacios, licencias y resolución de ejecutables.
- [ ] Confirmar Windows x64 y los destinos Linux x64 y WSL previstos por la distribución actual.
- [ ] Verificar por separado cualquier promesa para Linux arm64 remoto; no confundir servidor con IDE de escritorio.
- [ ] Fijar la implementación, versión del motor, ubicación y forma de empaquetarlo.

Salida: motor mínimo distribuible con diagnóstico y una tarea determinista, todavía sin prometer producto completo.

### Etapa 3: núcleo genérico y contrato

- [ ] Extraer el ciclo de tareas, planificación, ejecución y evidencia sin dependencias de RedEvent.
- [ ] Implementar esquema de configuración, handshake y errores estructurados.
- [ ] Implementar locks, estado atómico, identificación de intentos y recuperación segura.
- [ ] Implementar cancelación y concurrencia con límites verificables.
- [ ] Implementar caché de evidencias y sus condiciones de invalidación.
- [ ] Separar operaciones locales de los proveedores de IA y sus presupuestos.
- [ ] Cubrir con pruebas las reglas de aprobación, confianza y aislamiento entre raíces.

Salida: motor utilizable desde una entrada controlada y validado sin servicios externos obligatorios.

### Etapa 4: configuración del proyecto y adaptadores

- [ ] Implementar un generador con vista previa, validación y detección de colisiones.
- [ ] Proponer perfiles iniciales para proyectos Node, Go, PHP y proyectos con comandos personalizados.
- [ ] Distinguir herramienta instalada, configuración detectada y comando efectivamente probado.
- [ ] Agregar adaptadores de proveedor con capacidades y credenciales independientes.
- [ ] Mantener los adaptadores existentes de RedEvent y ArmotuSitio.
- [ ] Permitir retirar la configuración generada sin eliminar archivos propios del usuario.

Salida: un proyecto ajeno a RedEvent se configura y opera sin modificar sus archivos sin aprobación.

### Etapa 5: integración con el IDE

- [ ] Extender los servicios actuales de detección, actividad y ejecución sin duplicar su estado.
- [ ] Incorporar el flujo de configuración y mostrar claramente el motor seleccionado.
- [ ] Presentar planes, preguntas, aprobaciones, capacidades ausentes y errores del entorno.
- [ ] Comprobar actualización dinámica en inicio, barra de estado, paneles e historial.
- [ ] Asegurar navegación por teclado, foco, lectores de pantalla y temas claro y oscuro.
- [ ] Verificar confianza, múltiples raíces y ubicaciones remotas sin filtraciones entre proyectos.
- [ ] Conservar los controles actuales de MCP, proveedores y proyectos con Harness nativo.

Salida: recorrido completo desde proyecto sin configuración hasta tarea terminada y evidencia consultable.

### Etapa 6: empaquetado y aceptación integrada

- [ ] Incluir motor, recursos, runtime y atribuciones en los artefactos realmente distribuidos.
- [ ] Confirmar que empaquetado, limpieza de dependencias y `.vscodeignore` no eliminan piezas necesarias.
- [ ] Probar instalación nueva, actualización y apertura de un proyecto sin configuración previa.
- [ ] Probar coexistencia con un Harness nativo y recuperación de un proyecto inicializado con la versión anterior.
- [ ] Ejecutar la matriz funcional y los controles locales aplicables sobre el contenido final.
- [ ] Revisar el diff final y corregir regresiones antes del commit y PR.
- [ ] Integrar mediante PR con Actions deshabilitado y sin omitir las protecciones de `main`.

Salida: contenido listo para el release del usuario, con evidencia y limitaciones explícitas.

## Matriz mínima de aceptación

| Escenario | Resultado que debe demostrarse |
| --- | --- |
| Instalación limpia | El motor arranca sin rutas ni herramientas privadas del mantenedor |
| Proyecto nuevo | Configuración revisable y primera tarea local completada |
| Proyecto sin Git | Funciones locales disponibles; funciones de Git ausentes o explicadas |
| Node, Go y PHP | Los comandos configurados se ejecutan con herramientas disponibles y reportan evidencia real |
| Sin proveedor de IA | Diagnóstico y verificaciones locales funcionan; ejecución con IA explica qué falta |
| Proveedor no disponible | Error acotado; sin tarea falsa en ejecución ni reintentos ilimitados |
| Proyecto no confiable | No se permite ejecución ni modificación de configuración |
| Varias raíces | Estado, aprobaciones y credenciales no se cruzan |
| Harness nativo existente | Se preservan autoridad, tareas y flujos de RedEvent y ArmotuSitio |
| Plan o comandos modificados | La aprobación anterior deja de autorizar la ejecución |
| Cancelación y reinicio | No quedan procesos huérfanos ni se duplica una operación con resultado incierto |
| Lock persistido sin proceso | Se diagnostica como tal y se recupera mediante un flujo controlado |
| Rutas especiales y enlaces | Espacios, Unicode y escapes de raíz se resuelven o rechazan correctamente |
| Salida y archivos grandes | Se respetan límites y se mantiene utilizable la interfaz |
| Actualización del motor | No se pierden tareas y se rechaza un esquema incompatible sin alterar sus datos |
| Datos privados en salida | Los secretos no aparecen en UI, evidencia exportada ni logs compartibles |
| Windows y Linux | Se verifica el paquete de cada destino; una prueba en Windows no valida Linux |
| WSL y entorno remoto | El motor y las herramientas operan en el host correcto; no se presume compatibilidad |

Usar fixtures y proveedores simulados para pruebas deterministas y sin consumo de IA.

Las pruebas con proveedores reales se planifican por separado y requieren autorización para su consumo.

Medir arranque, refresco, carga de historial y cancelación antes de fijar y exigir umbrales de rendimiento.

## Validación técnica

Reutilizar los comandos del repositorio y las evidencias vigentes mientras no cambien sus entradas relevantes.

- Pruebas del motor y de su contrato, incluidos fallos, cancelación, recuperación y rutas no autorizadas.
- Pruebas y chequeos de `extensions/armotusitio-ide`, con cobertura nueva de selección del motor y configuración.
- Tipos del cliente y herramientas de build cuando sus cambios lo requieran.
- Pruebas del empaquetado para demostrar que el runtime llega al producto y al host correspondiente.
- Higiene, lint y verificación de Markdown sobre el contenido final aplicable.
- Smoke en una instancia aislada del IDE y en los paquetes de los destinos soportados.
- Aceptación humana de configuración, seguimiento, recuperación y mensajes de error.

Registrar comando, plataforma, commit o huella de entradas y resultado de cada comprobación.

No trasladar automáticamente a esta funcionalidad los resultados obtenidos para la actualización de VS Code.

## Publicación y transición

- Mantener el esquema de revisiones por versión base: la primera publicación de `1.144.0` es `r1`.
- Antes de fijar el tag, comprobar si el intento fallido dejó un borrador o una publicación existente.
- No reemplazar una publicación existente ni reutilizar un borrador asociado a otro commit sin resolver el conflicto.
- Invalidar validaciones y artefactos del intento anterior cuando cambie el contenido del producto.
- Conservar la clave de firma existente; no regenerarla como solución a un fallo del release.
- Verificar que `main` local y remoto contienen exactamente el resultado aprobado antes del release del usuario.
- Ejecutar primero el plan de solo lectura y luego seguir el flujo local de validación y publicación.

El primer salto desde clientes anteriores, como `1.143.1-r5`, requiere instalación manual o una versión puente.

Su actualizador ya compilado exige revisiones globalmente crecientes y no acepta automáticamente `1.144.0-r1`.

Referencia: [integración y compatibilidad de 1.144.0](docs/armotusitio-ide/UPSTREAM-1.144.md).

## Criterio de cierre

El plan se completa cuando un usuario puede instalar el IDE y operar el Harness en un proyecto independiente.

Deben estar verificadas la distribución, la seguridad, la recuperación y la compatibilidad de los destinos anunciados.

Las tareas, perfiles, extensiones y flujos existentes deben conservar su comportamiento y sus datos.

La documentación debe explicar configuración, requisitos, permisos, límites, diagnóstico y retirada del Harness.

La implementación integrada en `main` y el release publicado son hitos distintos y deben informarse por separado.

## Próxima acción

Empezar por la etapa 0: revisar el log original del release fallido y fijar una base de implementación comprobada.

Después, completar el inventario de extracción y el prototipo de runtime antes de modificar la experiencia del IDE.
