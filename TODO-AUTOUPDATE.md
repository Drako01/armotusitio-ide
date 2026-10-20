# TODO: actualizaciones de ArmotuSitio IDE

Estado: plan pendiente de implementación. Fecha: 20 de octubre de 2026.

## Objetivo y alcance

Detectar versiones estables de Code - OSS, incorporarlas conservando las personalizaciones y generar una distribución.
Permitir que los equipos instalados consulten y reciban las versiones de ArmotuSitio aprobadas.
Ejecutar la detección y el build en una computadora Windows, sin usar GitHub Actions.

Primera plataforma: Windows x64 con instalación por usuario. Linux, macOS y ARM64 quedan fuera de esta etapa.
El ZIP tendrá aviso y descarga de nuevas versiones; reemplazarlo automáticamente requiere un diseño separado.
La incorporación de upstream no habilita los demás módulos Enterprise AAA pendientes.

## Base existente y restricciones

- El remoto `upstream` apunta a `microsoft/vscode`; `origin` apunta a `Drako01/vscode`.
- Existe el empaquetado local `node scripts/ats-package-windows.mts`.
- Hay una distribución 1.143.0 probada al arrancar, con logo e íconos corregidos.
- Esa distribución no está firmada y no tiene un canal propio de actualizaciones configurado.
- GitHub Actions debe permanecer desactivado a nivel del repositorio.
- Los YAML de upstream se conservan; `[skip ci]` es una protección adicional, no la barrera principal.
- La automatización no modifica el checkout de trabajo ni publica en `main` por su cuenta.
- No se distribuyen perfiles, tokens, credenciales ni extensiones personales.

Consultar [distribución](docs/armotusitio-ide/DISTRIBUTION.md) y [evidencias](docs/armotusitio-ide/DELIVERY.md).

## Flujo previsto

Detección → preparación aislada → integración → validación → instalador candidato → aprobación → publicación → clientes.

Los errores detienen la promoción y conservan la última versión publicada.
Detectar una versión de Microsoft no equivale a tener una versión de ArmotuSitio lista para instalar.

## Etapa 1: fijar la base y la política de versiones

- [ ] Identificar el commit y la rama de Microsoft de los que deriva el fork actual.
- [ ] Comparar esa base con los tags estables; no asumir que el número 1.143.0 corresponde a una release estable.
- [ ] Resolver explícitamente la transición si la base actual está adelantada respecto del último tag estable.
- [ ] Impedir downgrades automáticos y decidir qué actualizaciones son compatibles con la base elegida.
- [ ] Registrar tag/commit upstream, commit del fork, revisión de distribución y canal en metadatos de build.
- [ ] Definir una revisión propia que permita publicar correcciones sin cambiar la versión base de VS Code.
- [ ] Definir comparación y orden de releases sin depender de comparar hashes o cadenas de versión literalmente.
- [ ] Fijar canales `candidate` y `stable`; los clientes normales consultan únicamente el segundo.
- [ ] Definir equipo responsable, ubicación de trabajo, retención de candidatos y política de aprobación.

Cierre: base reproducible identificada y reglas de selección de versiones documentadas y probadas.

## Etapa 2: detectar releases sin Actions

- [ ] Implementar un comando de consulta de releases/tags oficiales, sin modificar ni ejecutar código descargado.
- [ ] Ignorar borradores, versiones preliminares y versiones ya procesadas según la política definida.
- [ ] Validar repositorio de origen, tag y commit resuelto; fijar ese commit para toda la ejecución.
- [ ] Soportar timeout, fallos de red, límites de API y reintentos acotados con espera progresiva.
- [ ] Usar caché y consultas condicionales cuando estén disponibles para evitar consultas innecesarias.
- [ ] Registrar versión detectada, resultado y próximo paso sin guardar secretos.
- [ ] Implementar modo de simulación y ejecución manual con salida legible y códigos de retorno definidos.
- [ ] Registrar una tarea diaria de Windows con horario configurable, inicialmente deshabilitada hasta validarla.
- [ ] Evitar ejecuciones simultáneas mediante bloqueo y recuperar bloqueos abandonados tras un cierre inesperado.
- [ ] Ejecutar al recuperar una programación perdida; no exigir que el editor esté abierto.
- [ ] Documentar que la computadora debe estar encendida y cómo desactivar o eliminar la tarea.

Cierre: una versión nueva genera un único candidato; una consulta repetida no dispara otro build idéntico.

## Etapa 3: integrar upstream conservando ArmotuSitio

- [ ] Preparar un clon o worktree dedicado, con salida de build propia y dependencias independientes.
- [ ] Mantener intactos `main`, cambios locales, perfiles de usuario y el paquete publicado.
- [ ] Aplicar la versión seleccionada con una estrategia explícita de merge o parches, probada sobre la base real.
- [ ] Inventariar y proteger branding, `product.json`, extensión propia, temas, instalador y ajustes del build.
- [ ] Revisar cambios de API, Electron, Node, dependencias nativas y requisitos del Windows SDK.
- [ ] Tratar cambios de manifiestos, scripts de instalación y workflows como cambios que requieren revisión.
- [ ] Detenerse ante conflictos; no resolver automáticamente con una preferencia global por uno de los lados.
- [ ] Guardar un resumen de conflictos y rutas afectadas, sin publicar ni alterar el entorno del usuario.
- [ ] Revisar diferencias del candidato contra upstream y contra la distribución anterior.
- [ ] Actualizar la receta de build cuando cambie upstream, sin omitir controles para obtener un resultado verde.

Cierre: candidato integrado y revisable, con personalizaciones preservadas y sin conflictos pendientes.

## Etapa 4: validar y generar el candidato

- [ ] Reutilizar comandos y controles nativos del repositorio, sin inventar un segundo sistema de gates.
- [ ] Ejecutar higiene, lint y typechecks apropiados a los cambios incorporados.
- [ ] Ejecutar tests de la extensión propia y pruebas enfocadas de las áreas afectadas por upstream.
- [ ] Compilar y empaquetar Windows x64 con la receta mantenida en el repositorio.
- [ ] Probar arranque con perfil vacío, fuente de íconos, logo de título, inicio propio y comandos principales.
- [ ] Probar extensiones y flujos representativos del perfil ArmotuSitio/RedEvent y registrar incompatibilidades.
- [ ] Probar con un perfil existente de prueba que configuraciones y extensiones se conservan.
- [ ] Verificar que el paquete excluya credenciales, perfiles personales, proyectos y archivos temporales.
- [ ] Generar instalador, ZIP, hashes, notas y metadatos vinculados al commit realmente compilado.
- [ ] Conservar logs acotados y resultados; distinguir aprobado, fallido y no ejecutado.
- [ ] Detener la promoción ante un fallo requerido; limitar reintentos y consumo de disco.

Cierre: artefactos reproducibles y comprobaciones requeridas aprobadas; candidato disponible para revisión.

## Etapa 5: publicar una versión aprobada

- [ ] Elegir alojamiento HTTPS para instaladores y metadatos, con acceso apropiado para los compañeros.
- [ ] Evaluar GitHub Releases frente a alojamiento propio: permisos, tamaño, ancho de banda y mantenimiento.
- [ ] Definir firma de código de Windows y su gestión; no incluir claves privadas en Git ni en el cliente.
- [ ] Definir autenticidad del manifiesto y de artefactos; un hash publicado junto al archivo no basta por sí solo.
- [ ] Obtener aprobación explícita antes de publicar o promover un candidato a `stable`.
- [ ] Comprobar por API que Actions siga desactivado antes de cualquier push automatizado; si no, abortar.
- [ ] Publicar solo los commits revisados, conservando `[skip ci]` y sin crear PR automáticamente.
- [ ] Subir primero artefactos inmutables y verificar su descarga, tamaño, hash y firma.
- [ ] Publicar el manifiesto del canal al final, de forma atómica, sin anunciar archivos incompletos.
- [ ] Mantener la versión anterior disponible y permitir retirar una release defectuosa del canal.

Cierre: una versión aprobada se puede descargar y verificar; ningún workflow se inicia por su publicación.

## Etapa 6: conectar el actualizador de los clientes

- [ ] Reutilizar el servicio nativo de actualización de Code - OSS antes de considerar uno nuevo.
- [ ] Revisar `abstractUpdateService.ts` y `updateService.win32.ts` en `src/vs/platform/update/electron-main`.
- [ ] Implementar y probar el contrato real de `/api/update/{platform}/{quality}/{commit}`.
- [ ] Verificar campos, respuesta sin actualización y metadatos de descarga que espera esta versión del cliente.
- [ ] Configurar `updateUrl`, `quality`, commit y tipo de instalador en los metadatos de la distribución.
- [ ] Servir únicamente builds de ArmotuSitio; no apuntar al servicio de actualización de Microsoft.
- [ ] Separar los canales, arquitecturas y modalidades de instalación; rechazar paquetes incompatibles.
- [ ] Implementar consulta manual y periódica respetando preferencias, modo desactivado y fallos sin conexión.
- [ ] Verificar origen, autenticidad e integridad antes de ejecutar un instalador; rechazar respuestas inválidas.
- [ ] Descargar a una ubicación temporal y aplicar con el mecanismo nativo compatible con nuestro instalador.
- [ ] Respetar archivos sin guardar, sesiones y preferencias; acordar el reinicio con el usuario.
- [ ] Mantener una vía de descarga e instalación manual para fallos del actualizador y usuarios del ZIP.
- [ ] Distribuir una primera versión puente que incluya el actualizador mediante instalación manual.

Las instalaciones actuales no pueden descubrir el canal nuevo hasta recibir esa versión puente.

Cierre: un cliente instalado detecta una release aprobada, la verifica y se actualiza conservando su perfil.

## Etapa 7: recuperación y pruebas de extremo a extremo

- [ ] Probar instalación, actualización y desinstalación en una máquina Windows limpia.
- [ ] Probar actualización desde la distribución actual usando la versión puente.
- [ ] Probar red interrumpida, descargas truncadas, disco lleno, paquete alterado y manifiesto inválido.
- [ ] Probar canal sin novedades, arquitectura incorrecta y ejecución simultánea del detector.
- [ ] Probar permisos insuficientes, aplicación abierta, cancelación y reinicio pendiente.
- [ ] Probar fallo del build y conflicto upstream: ningún artefacto debe llegar al canal estable.
- [ ] Definir recuperación con instalador anterior y respaldo del perfil antes de migraciones incompatibles.
- [ ] Probar recuperación sin asumir que todas las migraciones admiten downgrade.
- [ ] Preparar pausa de consultas, retirada de una release y publicación de una corrección posterior.
- [ ] Registrar evidencia y comprobar en GitHub que no hubo ejecuciones nuevas de Actions.

Cierre: actualización y recuperación ensayadas, con las limitaciones restantes registradas.

## Etapa 8: operación y entrega

- [ ] Documentar consulta manual, generación de candidato, aprobación, publicación y recuperación.
- [ ] Documentar tarea de Windows, horarios, ubicación de logs y requisitos del equipo de build.
- [ ] Definir limpieza por antigüedad y espacio, preservando releases publicadas y evidencia necesaria.
- [ ] Mostrar versión base y revisión ArmotuSitio en la información del producto y los reportes de error.
- [ ] Informar novedades disponibles y fallos de actualización sin exponer datos de proyectos o usuarios.
- [ ] Validar primero con un equipo piloto antes de habilitar el canal al resto de los compañeros.
- [ ] Actualizar las guías de distribución y entrega con resultados reales y pendientes.

## Orden de implementación y decisiones pendientes

1. Resolver base estable y versionado; implementar detector manual y preparación aislada.
2. Incorporar validaciones y generación automática de candidatos; después programar la tarea diaria.
3. Elegir alojamiento, firma y aprobación; publicar manualmente una primera release verificable.
4. Conectar el actualizador nativo y distribuir la versión puente.
5. Ensayar actualización y recuperación; habilitar primero al piloto y luego al resto.

Quedan por decidir el equipo de build, el horario, el alojamiento, la firma y quién aprueba publicaciones.
Crear este TODO no registra tareas, activa servicios, publica archivos ni habilita GitHub Actions.
