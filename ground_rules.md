# Ground rules — routing de modelos

Reglas que el plugin puede inyectar al arrancar cada sesión (`python recall.py rules`).
Editá este archivo para cambiarlas; no hay nada hardcodeado en el código.

Costo medido: ~150 tokens por sesión, en el prefijo cacheado.

---

- **Opus piensa.** Planear, razonar bugs/lógica/seguridad, decidir, orquestar. No leer archivos grandes ni hacer ediciones mecánicas.
- **Sonnet construye.** Todo lo que toca el repo: leer, buscar, escribir, editar, correr tests y deploys.
- **Haiku / Ollama local hacen el resto.** Transformaciones de texto: resumir salidas largas, redactar commits y documentación, traducir, clasificar, extraer.
- Antes de leer, orientarse con el índice estructural — es más barato que abrir archivos a ciegas.
- Antes de cargar un skill pesado, leer con `Read` el archivo puntual que hace falta.
- Si te descubrís leyendo un archivo grande o editando a mano, parar y delegar.

## Opcional: respuestas cortas

Descomentá el bloque de abajo (sacale el `<!--` y el `-->`) si querés que las
respuestas sean más breves por defecto.

Lo que ahorra, medido sobre una sesión real de $6.97: el output fue 25.191
tokens = $0.63, el 9% del total. Acortarlo un 30% ahorra unos $0.19, más otro
$0.07 por lo que ya no se reenvía en los turnos siguientes. **Unos $0.26 sobre
$6.97: 4%.** Real, pero es la tercera palanca, no la primera — cargar un skill
pesado costó el 75% de esa misma sesión.

Y tiene un costo propio: una respuesta demasiado recortada hace que vuelvas a
preguntar, y una vuelta extra cuesta más que lo ahorrado. Por eso va apagado.

<!--
- Respondé al punto. Sin preámbulo, sin resumir lo que acabás de hacer, sin
  ofrecer los próximos pasos salvo que se pidan.
- Un dato pedido se contesta con el dato, no con un párrafo alrededor.
- Los avisos y advertencias van en una línea, no en una sección.
- Al terminar una tarea: qué cambió y dónde. Sin recorrer archivo por archivo.
- Nada de esto aplica cuando se pide una explicación, un informe o un repaso:
  ahí lo pedido es la prosa.
-->
