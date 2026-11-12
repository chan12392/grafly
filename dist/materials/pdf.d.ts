export declare function openPdf(bytes: Uint8Array): Promise<{
    numPages: number;
    readPage(page: number, render: boolean): Promise<{ text: string; png?: Uint8Array }>;
    close(): Promise<number>;
}>;
