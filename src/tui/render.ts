// DEPRECADO. El viejo run() usaba posicionamiento de cursor absoluto
// (\x1b7/\x1b8), frágil ante scroll. Lo reemplazó Screen (./screen.ts), que
// usa posicionamiento relativo y mantiene el prompt fijo abajo con printAbove.
// Este archivo quedó sin uso; podés borrarlo cuando quieras.
export {};
