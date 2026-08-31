# SOLVEA Fiscal

Motor tributario desacoplado para POS y sistemas de comandas SOLVEA. El primer consumidor es **Botillería San Pablo**.

## Estado de la fase 2

El servicio ya implementa el contrato HTTP que consume `botilleria-san-pablo` y ahora agrega el primer núcleo tributario real:

- boleta afecta TipoDTE 39 y boleta exenta TipoDTE 41;
- validación e idempotencia por venta;
- parser del archivo `AUTORIZACION` del CAF;
- validación RUT/tipo/rango y verificación del par de llaves RSA del CAF;
- reserva unívoca de folios, con persistencia local y bloqueo de concurrencia;
- construcción de `DD` y `TED`;
- firma `FRMT` con `SHA1withRSA` usando la llave privada entregada con el CAF;
- verificación interna de la firma TED;
- codificación de campos TED conforme a ISO-8859-1 y horario `America/Santiago`;
- generación del DTE con folio y TED incorporados.

**Todavía no emite una boleta válida ante el SII.** El resultado permanece en `processing` porque falta firmar el DTE completo con XMLDSIG/certificado digital, autenticarse ante el SII, enviarlo y obtener aceptación.

## API para Botillería San Pablo

### `POST /v1/documents/issue`

Acepta el payload que ya genera el módulo `commerce-fiscal` de la boti:

```json
{
  "idempotencyKey": "tax-<saleId>-boleta_afecta",
  "documentType": "boleta_afecta",
  "sale": {
    "id": "...",
    "number": "...",
    "subtotal": 12990,
    "discount": 0,
    "total": 12990,
    "paymentMethod": "cash",
    "completedAt": "2026-08-31T20:00:00-04:00"
  },
  "recipient": {},
  "items": [
    { "sku": "...", "name": "Producto", "quantity": 1, "unitPrice": 12990, "subtotal": 12990 }
  ]
}
```

Sin CAF configurado, `development` conserva el borrador de fase 1. Con un CAF válido configurado, la respuesta incluye un folio real reservado dentro del CAF y `fiscalStage: "ted_signed"`.

```json
{
  "status": "processing",
  "folio": "123",
  "externalId": "sf_...",
  "fiscalStage": "ted_signed",
  "ted": { "verified": true },
  "sii": { "submitted": false, "trackId": "", "accepted": false }
}
```

### `GET /v1/readiness`

Informa capacidades implementadas, configuración faltante y bloqueos antes de habilitar producción.

### `GET /health`

Healthcheck para Railway/Vercel/otros runtimes Node.

## Configuración de CAF

El valor de `SII_CAF_39_XML_BASE64` o `SII_CAF_41_XML_BASE64` debe ser el archivo XML completo `AUTORIZACION` entregado por el SII, codificado en Base64. No se debe extraer solamente el bloque `<CAF>` porque el servicio necesita también `RSASK` y `RSAPUBK`.

Para certificación debe configurarse además un directorio persistente:

```text
SOLVEA_FISCAL_STATE_DIR=/data/solvea-fiscal
SII_TIME_ZONE=America/Santiago
```

La reserva de folios se registra en `folio-state.json` mediante escritura atómica y archivo de bloqueo. Este mecanismo sirve para desarrollo/certificación en una instancia. Producción multi-instancia requerirá un almacén transaccional compartido.

## Desarrollo

```bash
cp .env.example .env
npm test
npm run check
npm start
```

Node.js 24 o superior. La fase 2 sigue sin dependencias npm externas.

## Integración de la boti

Botillería San Pablo ya quedó preparada para usar SOLVEA Fiscal automáticamente cuando existan:

```text
SOLVEA_FISCAL_URL=https://<solvea-fiscal>
SOLVEA_FISCAL_TOKEN=<token compartido>
```

El POS envía `idempotencyKey`, venta, receptor e ítems; SOLVEA Fiscal conserva ese contrato para no reescribir el flujo de caja.

## Hoja de ruta SII

1. ~~Parser CAF + reserva segura de folios 39/41.~~
2. ~~Construcción DD/TED y firma con la llave privada del CAF.~~
3. Verificar criptográficamente la firma del SII sobre el CAF.
4. Firma XMLDSIG del DTE con certificado digital vigente.
5. Semilla/token SII.
6. Envío de boleta, Track ID y consulta de estado.
7. Persistencia de documentos y worker de reintentos.
8. Resumen de Ventas Diarias / consumo de folios y notas de crédito.
9. Set de pruebas y certificación del primer RUT.
10. Persistencia transaccional multi-instancia para producción.

## Seguridad

Nunca subir certificados, contraseñas ni CAF al repositorio. El CAF contiene la llave privada de timbraje. `.gitignore` bloquea extensiones habituales y la carpeta `caf/`.
