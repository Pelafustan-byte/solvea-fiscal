# SOLVEA Fiscal

Motor tributario desacoplado para POS y sistemas de comandas SOLVEA. El primer consumidor es **Botillería San Pablo**.

## Estado de la fase 3

El servicio ya cubre el núcleo criptográfico previo al envío al SII:

- boleta afecta TipoDTE 39 y boleta exenta TipoDTE 41;
- parser del archivo `AUTORIZACION` del CAF;
- validación RUT/tipo/rango y verificación del par de llaves RSA del CAF;
- reserva unívoca e idempotente de folios;
- construcción y firma del `DD/TED` con `SHA1withRSA`;
- carga de certificado digital PKCS#12/PFX desde Base64;
- validación de vigencia y correspondencia entre certificado y llave privada;
- construcción de `TmstFirma` en horario `America/Santiago`;
- firma XMLDSIG del elemento `Documento` con C14N 1.0, RSA-SHA1 y digest SHA1;
- `KeyInfo` con `RSAKeyValue` y `X509Certificate`;
- verificación criptográfica local de la referencia firmada, incluyendo detección de alteraciones posteriores.

**Todavía no se marca una boleta como aceptada por el SII.** Aunque un DTE puede quedar en `fiscalStage: "dte_signed"`, la respuesta continúa en `processing` hasta implementar autenticación, envío y consulta de estado en el ambiente SII.

## API para Botillería San Pablo

### `POST /v1/documents/issue`

Acepta el contrato que ya genera el módulo `commerce-fiscal` de la boti. Con CAF y PFX válidos configurados, la respuesta queda así:

```json
{
  "status": "processing",
  "folio": "123",
  "externalId": "sf_...",
  "fiscalStage": "dte_signed",
  "ted": { "verified": true },
  "signature": {
    "verified": true,
    "documentId": "F123T39"
  },
  "sii": { "submitted": false, "trackId": "", "accepted": false }
}
```

Sin CAF configurado, `development` conserva el borrador de fase 1. Con CAF pero sin PFX, `development` puede producir `ted_signed`; en `certification` se exige CAF, PFX y persistencia de folios.

### `GET /v1/readiness`

Informa capacidades implementadas, configuración faltante y bloqueos antes de producción.

### `GET /health`

Healthcheck del servicio.

## Configuración fiscal

El CAF debe cargarse como el XML completo `AUTORIZACION` entregado por el SII, codificado en Base64. El certificado se carga como el archivo PFX/PKCS#12 completo codificado en Base64.

```text
SOLVEA_FISCAL_MODE=certification
SOLVEA_FISCAL_STATE_DIR=/data/solvea-fiscal
SII_TIME_ZONE=America/Santiago
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

La reserva de folios utiliza `folio-state.json` con escritura atómica y bloqueo de concurrencia. Es apta para una instancia en desarrollo/certificación; producción multi-instancia requerirá un almacén transaccional compartido.

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

El POS mantiene su flujo de caja y envía venta, ítems, receptor e `idempotencyKey` al motor fiscal.

## Hoja de ruta SII

1. ~~Parser CAF + reserva segura de folios 39/41.~~
2. ~~Construcción DD/TED y firma con la llave privada del CAF.~~
3. ~~Carga PFX y firma XMLDSIG completa del DTE.~~
4. Verificar criptográficamente la firma del SII sobre el CAF con la llave oficial aplicable.
5. Semilla/token SII con certificado digital.
6. Envío de boleta, Track ID y consulta de estado.
7. Persistencia de documentos y worker de reintentos.
8. Resumen de Ventas Diarias / consumo de folios y notas de crédito.
9. Set de pruebas y certificación del primer RUT.
10. Persistencia transaccional multi-instancia para producción.

## Seguridad

Nunca subir certificados, contraseñas ni CAF al repositorio. El CAF contiene la llave privada de timbraje y el PFX contiene la identidad de firma del contribuyente. Mantener ambos únicamente en secretos del entorno.
