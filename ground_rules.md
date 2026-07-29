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
