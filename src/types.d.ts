declare module "qrcode-svg" {
  type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";
  type QrContainer = "svg" | "svg-viewbox" | "g" | "none";

  interface QrCodeOptions {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: QrErrorCorrectionLevel;
    join?: boolean;
    predefined?: boolean;
    pretty?: boolean;
    xmlDeclaration?: boolean;
    container?: QrContainer;
  }

  export default class QRCode {
    constructor(content: string | QrCodeOptions);
    svg(): string;
  }
}
