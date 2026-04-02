# CLAUDE.md — Proyecto Goldfields (VPS)

## Conexion al servidor

Para ejecutar cualquier comando en el servidor, usa este patron SSH:

```bash
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "COMANDO"
```

**IMPORTANTE:** Antes de poder conectarte, debes crear el archivo de clave SSH. Ejecuta esto UNA SOLA VEZ al inicio de la sesion:

```bash
mkdir -p ~/.ssh
cat > ~/.ssh/goldfields_key << 'KEYEOF'
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACB7pOh9zM0hfap/NVHpx4S97jhxbfIjnaD8bxxx64fVfgAAAJhmFBFLZhQR
SwAAAAtzc2gtZWQyNTUxOQAAACB7pOh9zM0hfap/NVHpx4S97jhxbfIjnaD8bxxx64fVfg
AAAEAV0b/BWUD3e0rZJbXI7+h2gmCwWqqC1t/O1Y/SSi9Z9Xuk6H3MzSF9qn81UenHhL3u
OHFt8iOdoPxvHHHrh9V+AAAADmRldkBzcnYxNDI1MDEzAQIDBAUGBw==
-----END OPENSSH PRIVATE KEY-----
KEYEOF
chmod 600 ~/.ssh/goldfields_key
```

## RESTRICCIONES CRITICAS

**PROHIBIDO tocar contenedores o servicios Docker que NO sean del proyecto Goldfields.**
Este servidor tiene otros proyectos corriendo. Solo puedes interactuar con estos 3 contenedores:
- `goldfields-backend`
- `goldfields-agents`
- `goldfields-frontend`

**NO ejecutar:**
- `docker stop/rm/kill` en contenedores que no empiecen con `goldfields-`
- `docker system prune`, `docker volume prune`, `docker image prune`
- `docker compose down` fuera de `/root/goldfields/`
- Cualquier comando que afecte contenedores, volumenes o imagenes de otros proyectos

**Siempre filtrar por nombre** al listar contenedores: `docker ps --filter name=goldfields`

## Datos del servidor

- **Host:** aiprowork.com
- **Usuario:** dev
- **URL de la app:** https://goldfields.aiprowork.com
- **Proyecto en servidor:** /root/goldfields/

## Como ejecutar comandos remotos

Siempre usa este formato para ejecutar comandos en el servidor:

```bash
# Comando simple
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "docker ps"

# Comandos multiples (usar && o ;)
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "cd /root/goldfields && docker compose ps"

# Ver logs de un servicio
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "docker logs goldfields-backend --tail 50"
```

## Nota sobre permisos

El usuario `dev` tiene acceso sudo. Si un comando requiere root, usa `sudo`:

```bash
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "sudo docker ps"
```

Si el usuario dev NO tiene sudo, los comandos en /root/ fallaran. En ese caso necesitas pedir que muevan el proyecto a /home/dev/ o que den permisos.

## Arquitectura del proyecto

```
/root/goldfields/
├── docker-compose.yml              # Orquestacion de 3 servicios
├── .env                            # GROQ_API_KEY para agentes IA
├── goldfieldsPermitBackend-main/    # FastAPI backend (puerto 8001, SQLite)
├── goldfieldsPermitAgents-feature-mergeo/  # Agentes IA LangChain+Groq (puerto 8000)
└── goldfieldsPermitFrontend-feature-mergeo/ # React+Vite frontend (puerto 3001 → nginx:80)
```

### Servicios Docker

| Contenedor | Puerto | Stack |
|---|---|---|
| goldfields-backend | 8001 | FastAPI + SQLAlchemy + SQLite |
| goldfields-agents | 8000 | FastAPI + LangChain + Groq (Llama 3.3 70B) |
| goldfields-frontend | 3001→80 | React + Vite + Tailwind (nginx) |

### Proxy nginx (dentro del frontend)

- `/api/v1/*` → `http://backend:8001/*` (se quita el prefijo /api/v1)
- `/agents-api/*` → `http://agents:8000/api/*`
- Todo lo demas → SPA fallback (index.html)

## Comandos utiles

```bash
# Estado de contenedores
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "docker ps --filter name=goldfields"

# Logs de un servicio (ultimas 100 lineas)
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "docker logs goldfields-backend --tail 100"
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "docker logs goldfields-agents --tail 100"
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "docker logs goldfields-frontend --tail 100"

# Reconstruir y reiniciar un servicio
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "cd /root/goldfields && docker compose build backend && docker compose up -d backend"

# Reconstruir todo
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "cd /root/goldfields && docker compose up -d --build"

# Reiniciar sin reconstruir
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "cd /root/goldfields && docker compose restart"

# Ver .env
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "cat /root/goldfields/.env"

# Editar un archivo remoto (ejemplo: .env)
ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "echo 'GROQ_API_KEY=gsk_xxx' > /root/goldfields/.env"
```

## Flujo para hacer cambios en el codigo

1. Editar archivos localmente en la carpeta del proyecto
2. Subir al servidor con scp o rsync:
   ```bash
   scp -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no -r ./goldfieldsPermitBackend-main/ dev@aiprowork.com:/root/goldfields/goldfieldsPermitBackend-main/
   ```
3. Reconstruir el servicio modificado:
   ```bash
   ssh -i ~/.ssh/goldfields_key -o StrictHostKeyChecking=no dev@aiprowork.com "cd /root/goldfields && docker compose build backend && docker compose up -d backend"
   ```

## API endpoints del backend

- `GET /wbs` — Lista WBS
- `GET /permits` — Lista permisos (filtros: gerencia, estado, autoridad, contratista, search)
- `GET /permits/{codigo_aconex}` — Detalle de permiso con milestones
- `GET /documents?permit_id=X` — Documentos de un permiso
- `POST /documents` — Crear documento
- `PATCH /documents/{id}` — Actualizar documento
- `GET /rca/{wbs_id}/summary` — Resumen RCA por WBS
- `GET /rca/wbs/{wbs_id}/permit-summary` — Resumen permisos por WBS
- `GET /rca/obra-summary?obra=X` — Resumen por obra
- `POST /notifications/send` — Enviar notificacion (stub)
