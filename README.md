# SOLVEA Fiscal

Motor tributario desacoplado para POS y sistemas de comandas SOLVEA. El primer consumidor es **Botillería San Pablo**.

## Estado actual

SOLVEA Fiscal ya implementa el circuito técnico necesario para probar Boleta Electrónica en el ambiente de certificación del SII:

- boleta afecta TipoDTE 39 y boleta exenta TipoDTE 41;
- parser del archivo `AUTORIZACION` del CAF;
- reserva unívoca, persistente e idempotente de folios;
- construcción y firma del `DD/TED` con la llave del CAF;
- carga y validación de certificado digital PKCS#12/PFX;
- firma y verificación XMLDSIG del `Documento`;
- semilla, firma de semilla y token SII;
- construcción y firma del sobre `EnvioBOLETA_v11`;
- upload multipart al servicio de Boleta Electrónica;
- persistencia del Track ID;
- protección `submitting/submitted/uncertain` contra reenvíos ciegos;
- consulta posterior del Track ID y clasificación conservadora como aceptado, rechazado o en proceso;
- probe seguro de certificación que comprueba PFX + semilla + token sin consumir folios ni enviar documentos.

**Producción continúa bloqueada intencionalmente.** El objetivo actual es probar y certificar el contribuyente en el ambiente SII antes de habilitar emisión productiva.

## Circuito recomendado de sandbox

### 1. Configurar certificación

```text
SOLVEA_FISCAL_MODE=certification
SOLVEA_FISCAL_STATE_DIR=/data/solvea-fiscal
SOLVEA_FISCAL_API_TOKEN=<token interno fuerte>
SII_TIME_ZONE=America/Santiago
SII_NETWORK_ENABLED=true

# Dejarlos vacíos usa los defaults de certificación:
SII_AUTH_BASE_URL=
SII_BOLETA_BASE_URL=

SII_RUT_ENVIA=<RUT autorizado que firma/envía>
SII_RUT_RECEPTOR=60803000-K
SII_FCH_RESOL=<fecha aplicable al ambiente/contribuyente>
SII_NRO_RESOL=<número aplicable al ambiente/contribuyente>

SII_RUT_EMISOR=<RUT contribuyente>
SII_RAZON_SOCIAL=<razón social>
SII_GIRO=<giro>
SII_DIRECCION_ORIGEN=<dirección>
SII_COMUNA_ORIGEN=CONSTITUCION
SII_CIUDAD_ORIGEN=CONSTITUCION
SII_CODIGO_SUCURSAL=

SII_CERT_PFX_BASE64=<PFX en Base64>
SII_CERT_PASSWORD=<contraseña PFX>
SII_CAF_39_XML_BASE64=<AUTORIZACION CAF 39 de certificación en Base64>
SII_CAF_41_XML_BASE64=<opcional CAF 41>
```

En `certification`, los defaults son:

```text
autenticación -> https://apicert.sii.cl/recursos/v1
boletas       -> https://pangal.sii.cl/recursos/v1
```

### 2. Revisar readiness

`GET /v1/readiness`

Debe informar `sandboxReady: true` antes de enviar una boleta real de certificación.

### 3. Probar sólo autenticación

`POST /v1/sandbox/probe`

Este endpoint está diseñado para la primera prueba real. Comprueba:

```text
PFX -> llave/certificado -> vigencia -> semilla apicert -> firma -> token
```

No devuelve el token, no reserva folio y no envía un DTE. Además se niega a funcionar si las URLs configuradas no son exactamente `apicert.sii.cl` y `pangal.sii.cl`.

### 4. Emitir una boleta de certificación

`POST /v1/documents/issue`

Ejemplo del contrato que usa la boti:

```json
{
  "idempotencyKey": "tax-sandbox-0001-boleta_afecta",
  "documentType": "boleta_afecta",
  "sale": {
    "id": "sandbox-0001",
    "number": "SBX-000001",
    "subtotal": 1990,
    "discount": 0,
    "total": 1990,
    "paymentMethod": "cash",
    "completedAt": "2026-08-31T20:00:00-04:00"
  },
  "recipient": {},
  "items": [
    {
      "sku": "SANDBOX-001",
      "name": "Producto prueba certificacion",
      "quantity": 1,
      "unitPrice": 1990,
      "subtotal": 1990
    }
  ]
}
```

Si el upload es recibido, la respuesta queda `processing`, incluye el folio reservado y el Track ID, pero **no se declara todavía aceptada**.

### 5. Refrescar el estado del Track ID

`POST /v1/documents/status`

```json
{
  "idempotencyKey": "tax-sandbox-0001-boleta_afecta"
}
```

La respuesta se normaliza a uno de estos resultados:

```text
status=processing  -> el SII aún está procesando el envío
status=issued      -> aceptación confirmada
status=rejected    -> rechazo confirmado
```

Los datos originales del SII (`estado`, glosa y cantidades informadas/aceptadas/rechazadas/reparos cuando existan) se conservan en el objeto `sii`.

## API para Botillería San Pablo

### `POST /v1/documents/issue`

Recibe venta, ítems, receptor e `idempotencyKey`. En sandbox ejecuta:

```text
validar venta
 -> reservar folio CAF
 -> construir TED
 -> firmar DTE
 -> construir EnvioBOLETA
 -> firmar SetDTE
 -> obtener token SII
 -> upload
 -> persistir Track ID
```

### `POST /v1/documents/status`

Consulta el Track ID persistido para la misma `idempotencyKey` y actualiza el estado fiscal.

### `POST /v1/sandbox/probe`

Diagnóstico seguro de autenticación, exclusivo de certificación.

### `GET /v1/readiness`

Informa configuración, capacidades y si el sandbox está efectivamente listo.

### `GET /health`

Healthcheck del servicio.

## Seguridad e idempotencia

El token SII nunca sale del backend. El PFX, su contraseña y los CAF deben existir únicamente como secretos del entorno.

Antes de iniciar el upload se persiste `submitting`. Si la conexión se corta en una zona incierta, SOLVEA Fiscal conserva `uncertain` y no reenvía automáticamente la misma `idempotencyKey`. Esto evita duplicar envíos por un reinicio entre la recepción SII y la respuesta HTTP.

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

Botillería San Pablo usa:

```text
SOLVEA_FISCAL_URL=https://<solvea-fiscal>
SOLVEA_FISCAL_TOKEN=<token compartido>
```

El POS conserva el flujo de caja y SOLVEA Fiscal concentra certificado, CAF, autenticación, envío y seguimiento tributario.

## Hoja de ruta restante

1. ~~CAF + reserva segura de folios 39/41.~~
2. ~~DD/TED + firma con llave CAF.~~
3. ~~PFX + XMLDSIG del DTE.~~
4. ~~Semilla/token SII.~~
5. ~~`EnvioBOLETA` + upload + Track ID.~~
6. ~~Consulta manual/API de Track ID y clasificación de aceptación/rechazo.~~
7. Ejecutar pruebas reales del set de certificación con el primer RUT.
8. Verificar la firma del SII sobre el CAF con la llave pública oficial aplicable.
9. Implementar Resumen de Ventas Diarias/consumo de folios y documentos de ajuste requeridos.
10. Agregar worker de conciliación y persistencia transaccional multi-instancia antes de producción.

## Seguridad

Nunca subir certificados, contraseñas, CAF ni tokens al repositorio. Producción permanece deshabilitada hasta terminar la certificación y el endurecimiento operacional.
