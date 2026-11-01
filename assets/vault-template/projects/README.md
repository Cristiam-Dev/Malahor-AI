---
type: projects-index
format: malahor-markdown-v1
---

# Projects

Documentacion canonica aislada por clave de proyecto.

## Convencion

Malahor crea una carpeta por proyecto registrado:

Ejemplo:

```text
projects/
  malahor/
    README.md
    Product/
    Design/
    SDD/
    Discovery/
```

Los agentes operan estas carpetas mediante `docs_*` con paths relativos al proyecto y control optimista de versiones. La persona puede pedirlo en lenguaje natural: el agente infiere la clave, busca antes de crear y reporta el path afectado. No mover contenido entre claves, borrar permanentemente ni crear copias documentales en repositorios de codigo.
