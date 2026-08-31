# SOLVEA Fiscal

Motor tributario desacoplado para POS y sistemas de comandas SOLVEA. El primer consumidor es **Botillería San Pablo**.

## Estado de la fase 4

El servicio ya cubre el núcleo criptográfico del DTE y el flujo de autenticación automática del SII:

- boleta afecta TipoDTE 39 y boleta exenta TipoDTE 41;
- parser del archivo `AUTORIZACION` del CAF;
- reserva unívoca e idempotente de folios;
- construcción y firma del `DD/TED` con `SHA1withRSA`;
- carga y validación de certificado digital PKCS#12/PFX;
- firma y verificación XMLDSIG del `Documento`;
- obtención REST de semilla SII;
- construcción de `<getToken><item><Semilla>...</Semilla></item></getToken>`;
- firma XMLDSIG de la semilla con `Reference URI=""` y transform `enveloped-signature`;
- envío REST de la semilla firmada para obtener token;
- validación de `ESTADO`, `SEMILLA` y `TOKEN` en respuestas XML;
- separación automática de ambiente de certificación y producción;
- red SII deshabilitada por defecto para impedir llamadas accidentales.

**Todavía no se marca una boleta como aceptada por el SII.** El DTE continúa en `processing` hasta implementar el sobre de envío, POST de boleta, Track ID y consulta de estado.

## API para Botillería San Pablo

### `POST /v1/documents/issue`

Acepta el contrato que ya genera el módulo `commerce-fiscal` de la boti. Con CAF y PFX válidos configurados produce un DTE con TED y XMLDSIG verificadas localmente:

```json
{
  "status": "processing",
  "folio": "123",
  "externalId": "sf_...",
  "fiscalStage": "dte_signed",
  "ted": { "verified": true },
  "signature": { "verified": true, "documentId": "F123T39" },
  "sii": { "submitted": false, "trackId": "", "accepted": false }
}
```

### `GET /v1/readiness`

Informa capacidades implementadas, datos faltantes, ambiente SII y si la red está habilitada.

### `GET /health`

Healthcheck del servicio.

## Autenticación SII

El cliente interno usa los servicios REST de Boleta Electrónica. Por defecto:

```text
certification -> https://apicert.sii.cl/recursos/v1
production    -> https://api.sii.cl/recursos/v1
```

La secuencia implementada es:

```text
GET  /boleta.electronica.semilla
  -> extraer SEMILLA
  -> firmar getToken con certificado digital
POST /boleta.electronica.token (application/xml)
  -> extraer TOKEN
```

La semilla se firma con C14N 1.0, RSA-SHA1, digest SHA1, `Reference URI=""` y transform `enveloped-signature`, de acuerdo con el manual de autenticación automática del SII.

No existe endpoint público que entregue el token al POS. La autenticación queda encapsulada dentro de SOLVEA Fiscal para que la caja nunca reciba ni administre credenciales SII.

## Configuración fiscal

```text
SOLVEA_FISCAL_MODE=certification
SOLVEA_FISCAL_STATE_DIR=/data/solvea-fiscal
SII_TIME_ZONE=America/Santiago
SII_NETWORK_ENABLED=false
SII_AUTH_BASE_URL=
SII_HTTP_TIMEOUT_MS=15000
SII_RUT_EMISOR=...
SII_RAZON_SOCIAL=...
SII_GIRO=...
SII_DIRECCION_ORIGEN=...
SII_COMUNA_ORIGEN=CONSTITUCION
SII_CIUDAD_ORIGEN=CONSTITUCION
SII_CERT_PFX_BASE64=...
SII_CERT_PASSWORD=...
SII_CAF_39_XML_BASE64=...
```

`SII_NETWORK_ENABLED` permanece en `false` hasta que la instancia esté preparada para certificación real. Los endpoints pueden sobreescribirse con variables de entorno para no acoplar el código a una URL fija.

## Desarrollo

```bash
cp .env.example .env
npm install
npm test
npm run check
npm start
```

Node.js 24 o superior.

## Integración de la boti

Botillería San Pablo ya está preparada para usar este servicio cuando existan:

```text
SOLVEA_FISCAL_URL=https://<solvea-fiscal>
SOLVEA_FISCAL_TOKEN=<token compartido>
```

El POS mantiene su flujo de caja; toda la identidad tributaria y autenticación SII queda en SOLVEA Fiscal.

## Hoja de ruta SII

1. ~~Parser CAF + reserva segura de folios 39/41.~~
2. ~~Construcción DD/TED y firma con la llave privada del CAF.~~
3. ~~Carga PFX y firma XMLDSIG completa del DTE.~~
4. ~~Firma de semilla + cliente REST de obtención de token SII.~~
5. Verificar criptográficamente la firma del SII sobre el CAF con la llave oficial aplicable.
6. Construir `EnvioBOLETA`, enviar DTE y guardar Track ID.
7. Consulta de estado, persistencia y worker de reintentos.
8. Resumen de Ventas Diarias / consumo de folios y notas de crédito.
9. Set de pruebas y certificación del primer RUT.
10. Persistencia transaccional multi-instancia para producción.

## Seguridad

Nunca subir certificados, contraseñas, CAF ni tokens al repositorio. El token SII no se devuelve al POS y las llamadas externas permanecen deshabilitadas hasta activarlas explícitamente.
