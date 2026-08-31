# SOLVEA Fiscal

Motor tributario desacoplado para POS y sistemas de comandas SOLVEA. El primer consumidor es **Botillería San Pablo**.

## Estado de la fase 1

Esta fase implementa el contrato HTTP que ya consume `botilleria-san-pablo`, validación de boletas 39/41, idempotencia, normalización de RUT, mapeo de medios de pago y generación de un **borrador XML no tributario**.

**Todavía no emite boletas válidas ante el SII.** En modo `development` responde `processing` para que ningún POS confunda el borrador con un DTE aceptado. Los modos `certification` y `production` permanecen bloqueados hasta implementar y probar CAF, TED, firma XML, autenticación, envío, consulta de estado y certificación SII.

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

Respuesta de fase 1:

```json
{
  "status": "processing",
  "folio": "",
  "externalId": "sf_...",
  "xml": "...",
  "sii": { "submitted": false, "trackId": "", "accepted": false }
}
```

### `GET /v1/readiness`

Informa configuración faltante y bloqueos para habilitar certificación/producción.

### `GET /health`

Healthcheck para Railway/Vercel/otros runtimes Node.

## Desarrollo

```bash
cp .env.example .env
npm test
npm run check
npm start
```

Node.js 24 o superior. No se incorporan dependencias externas en esta fase.

## Integración de la boti

El proveedor tributario de Botillería San Pablo debe quedar con:

```text
mode = external
endpoint = https://<solvea-fiscal>/v1/documents/issue
tokenEnv = SOLVEA_FISCAL_TOKEN
```

El POS ya envía `idempotencyKey`, venta, receptor e ítems; SOLVEA Fiscal conserva exactamente ese contrato para evitar reescribir el flujo de caja.

## Hoja de ruta SII

1. Custodia cifrada de certificado digital y CAF por contribuyente.
2. Parser CAF + reserva transaccional de folios 39/41.
3. Construcción DD/TED y firma con clave privada del CAF.
4. Construcción XML conforme al formato vigente de boleta electrónica.
5. Firma XML con certificado digital.
6. Semilla/token SII.
7. Envío de boleta, Track ID y consulta de estado.
8. Persistencia y worker de reintentos.
9. Reporte de ventas/consumo de folios y notas de crédito.
10. Set de pruebas y certificación del primer RUT.

## Seguridad

Nunca subir certificados, contraseñas ni CAF al repositorio. `.gitignore` bloquea extensiones habituales y la carpeta `caf/`.
