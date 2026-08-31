# SOLVEA Fiscal

Servicio tributario desacoplado para integrar POS y sistemas de comandas con documentos tributarios electrónicos de Chile.

## Primer consumidor: Botillería San Pablo

`botilleria-san-pablo` ya dispone de un proveedor tributario HTTP desacoplado. SOLVEA Fiscal implementa ese contrato y será el punto único para la emisión de boletas electrónicas desde el POS.

> Estado: construcción inicial. Ninguna respuesta de desarrollo debe interpretarse como una boleta válida ante el SII hasta completar CAF, TED, firma XML, autenticación, envío, seguimiento y certificación.
