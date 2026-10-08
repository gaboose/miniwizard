export function combineMovementSources({input, cameraDrag}) {
    return {
        get direction() {
            var d = input.direction;
            if (d.x != 0 || d.y != 0) return d;
            else return cameraDrag?.direction ?? {x: 0, y: 0};
        }
    }
}