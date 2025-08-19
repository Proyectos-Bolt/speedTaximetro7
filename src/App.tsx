import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Square, Navigation, DollarSign, Clock, Route, Info, ChevronDown, ChevronUp, Zap, MapPin, TestTube } from 'lucide-react';
import { initializeGoogleMaps, calculateDistanceWithGoogleMaps, isGoogleMapsReady, getLocationInfo } from './services/googleMaps';
import InstallPrompt from './components/InstallPrompt';
import { useServiceWorker } from './hooks/useServiceWorker';

interface Position {
  latitude: number;
  longitude: number;
  timestamp: number;
}

interface OriginPosition {
  latitude: number;
  longitude: number;
}
interface TripData {
  distance: number;
  duration: number;
  waitingTime: number;
  cost: number;
  isRunning: boolean;
  isPaused: boolean;
}

interface TripSummary {
  distance: number;
  waitingTime: number;
  cost: number;
  timestamp: string;
  tripType: string;
}

interface TripType {
  id: string;
  name: string;
  description: string;
  fixedPrice?: number;
  distanceKm?: number;
  subTrips?: {
    id: string;
    name: string;
    fixedPrice: number;
  }[];
}

// Tipos de viaje disponibles
const TRIP_TYPES: TripType[] = [
  {
    id: 'normal',
    name: 'Viaje Normal',
    description: 'Tarifa por distancia recorrida'
  },
  {
    id: 'walmart',
    name: 'A Walmart',
    description: 'Centro → Walmart Ciudad Guzmán',
    distanceKm: 5.2,
    fixedPrice: 60
  }
 ,
  {
    id: 'tecnologico',
    name: 'Al Tecnológico',
    description: 'Centro → Tecnológico de Ciudad Guzmán',
    distanceKm: 5.9,
    fixedPrice: 70
  }
  ,
  {
    id: 'cristoRey',
    name: 'Cristo Rey',
    description: 'Centro → Cristo Rey',
    subTrips: [
      {
        id: 'cristoRey-cano',
        name: 'Caño',
        fixedPrice: 60
      },
      {
        id: 'cristoRey-mitad',
        name: 'Mitad',
        fixedPrice: 70
      },
      {
        id: 'cristoRey-arriba',
        name: 'Arriba',
        fixedPrice: 80
      }
    ]
  }
];

// Configuración de tarifas
const RATES = {
  baseFare: 50, // Tarifa base en MXN
  waitingRate: 3, // Costo por minuto de espera en MXN
  ranges: [
    { min: 0, max: 4, price: 50 },
    { min: 4, max: 5, price: 60 },
    { min: 5, max: 6, price: 65 },
    { min: 6, max: 7, price: 70 },
    { min: 7, max: 8, price: 80 },
    { min: 8, max: Infinity, price: 80 } // Después de 8km mantiene el precio
  ]
};

function App() {
  // Registrar service worker
  useServiceWorker();

  const [tripData, setTripData] = useState<TripData>({
    distance: 0,
    duration: 0,
    waitingTime: 0,
    cost: RATES.baseFare,
    isRunning: false,
    isPaused: false
  });

  const [currentPosition, setCurrentPosition] = useState<Position | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'unavailable' | 'requesting' | 'available' | 'denied'>('unavailable');
  const [showRates, setShowRates] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [lastTripSummary, setLastTripSummary] = useState<TripSummary | null>(null);
  const [googleMapsReady, setGoogleMapsReady] = useState(false);
  const [currentAddress, setCurrentAddress] = useState<string>('');
  const [isTestMode, setIsTestMode] = useState(false);
  const [selectedTripType, setSelectedTripType] = useState<TripType>(TRIP_TYPES[0]);
  const [showTripTypeSelector, setShowTripTypeSelector] = useState(false);
  const [selectedSubTrip, setSelectedSubTrip] = useState<{id: string; name: string; fixedPrice: number} | null>(null);
  const [showSubTripSelector, setShowSubTripSelector] = useState(false);
  
  // Función para obtener el precio base según el tipo de viaje
  const getBasePrice = (tripType: TripType): number => {
    if (selectedSubTrip && tripType.id === 'cristoRey') {
      return selectedSubTrip.fixedPrice;
    }
    return tripType.fixedPrice || RATES.baseFare;
  };
  
  const lastPosition = useRef<Position | null>(null);
  const originPosition = useRef<OriginPosition | null>(null);
  const totalDistanceAccumulated = useRef<number>(0);
  const startTime = useRef<number | null>(null);
  const pauseStartTime = useRef<number | null>(null);
  const watchId = useRef<number | null>(null);
  const intervalId = useRef<number | null>(null);
  const testIntervalId = useRef<number | null>(null);

  // Función para calcular distancia desde el origen usando Haversine
  const calculateDistanceFromOrigin = (origin: OriginPosition, current: Position): number => {
    const R = 6371; // Radio de la Tierra en kilómetros
    const dLat = (current.latitude - origin.latitude) * Math.PI / 180;
    const dLng = (current.longitude - origin.longitude) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(origin.latitude * Math.PI / 180) * Math.cos(current.latitude * Math.PI / 180) * 
      Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  // Efecto para actualizar el costo cuando cambia el tipo de viaje (solo si no está corriendo)
  useEffect(() => {
    if (!tripData.isRunning) {
      setTripData(prev => ({
        ...prev,
        cost: getBasePrice(selectedTripType)
      }));
    }
  }, [selectedTripType, selectedSubTrip, tripData.isRunning]);

  // Función alternativa usando Google Maps si está disponible
  const calculateDistanceFromOriginWithGoogleMaps = (origin: OriginPosition, current: Position): number => {
    if (!isGoogleMapsReady() || !window.google) {
      return calculateDistanceFromOrigin(origin, current);
    }

    try {
      const point1 = new google.maps.LatLng(origin.latitude, origin.longitude);
      const point2 = new google.maps.LatLng(current.latitude, current.longitude);
      const distance = google.maps.geometry.spherical.computeDistanceBetween(point1, point2);
      return distance / 1000; // Convertir de metros a kilómetros
    } catch (error) {
      console.error('Error con Google Maps, usando Haversine:', error);
      return calculateDistanceFromOrigin(origin, current);
    }
  };

  // Calcular costo basado en distancia desde origen
  const calculateCostFromDistance = (distanceKm: number, waitingMinutes: number): number => {
    // Si es un viaje con precio base específico, usar ese precio
    if (selectedTripType.fixedPrice || (selectedTripType.id === 'cristoRey' && selectedSubTrip)) {
      const basePrice = selectedTripType.id === 'cristoRey' && selectedSubTrip 
        ? selectedSubTrip.fixedPrice 
        : selectedTripType.fixedPrice!;
      
      // Cristo Rey tiene distancia base de 1.5 km
      const baseDistance = selectedTripType.id === 'cristoRey' ? 1.5 : (selectedTripType.distanceKm || 0);
      let baseCost = basePrice;
      
      // Si se pasa de la distancia base, agregar costo extra
      if (distanceKm > baseDistance) {
        const extraKm = distanceKm - baseDistance;
        
        if (selectedTripType.id === 'cristoRey') {
          // Lógica especial para Cristo Rey
          let extraCost = 0;
          if (extraKm > 3) {
            extraCost = 20; // +$20 si supera por más de 3km
          } else if (extraKm > 2) {
            extraCost = 10; // +$10 si supera por más de 2km
          }
          baseCost += extraCost;
          console.log(`Cristo Rey - Distancia extra: ${extraKm.toFixed(3)}km, Costo extra: $${extraCost}`);
        } else {
          // Lógica normal para otros destinos fijos
          const extraCost = extraKm * 10; // $10 por km adicional
          baseCost += extraCost;
          console.log(`Distancia extra: ${extraKm.toFixed(3)}km, Costo extra: $${extraCost.toFixed(2)}`);
        }
      }
      
      const waitingCost = waitingMinutes * RATES.waitingRate;
      console.log(`Viaje ${selectedTripType.name}: Base $${baseCost}, Espera $${waitingCost.toFixed(2)}, Total $${baseCost + waitingCost}`);
      return baseCost + waitingCost;
    }
    
    // Cálculo normal por distancia
    let baseCost = 0;
    
    if (distanceKm < 5) {
      baseCost = 50;
    } else if (distanceKm < 6) {
      baseCost = 60;
    } else if (distanceKm < 7) {
      baseCost = 65;
    } else if (distanceKm < 8) {
      baseCost = 70;
    } else if (distanceKm <= 8) {
      baseCost = 80;
    } else {
      // Más de 8 km: $80 base + $16 por cada km adicional
      const extraKm = distanceKm - 8;
      baseCost = 80 + (extraKm * 16);
    }
    
    const waitingCost = waitingMinutes * RATES.waitingRate;
    console.log(`Distancia desde origen: ${distanceKm.toFixed(3)}km, Costo base: $${baseCost}, Costo espera: $${waitingCost.toFixed(2)}`);
    return baseCost + waitingCost;
  };

  // Función para simular avance en modo de prueba
  const simulateMovement = () => {
    if (!originPosition.current || !tripData.isRunning || tripData.isPaused) return;

    // Simular movimiento agregando pequeñas cantidades de distancia
    const simulatedDistance = Math.random() * 0.05 + 0.02; // Entre 0.02 y 0.07 km por segundo
    
    setTripData(prev => {
      const newDistance = prev.distance + simulatedDistance;
      const newCost = calculateCostFromDistance(newDistance, prev.waitingTime / 60);
      
      console.log('🧪 Modo prueba - Distancia simulada:', newDistance.toFixed(3), 'km, Costo: $', newCost);
      
      return {
        ...prev,
        distance: newDistance,
        cost: newCost
      };
    });

    // Simular actualización de posición para mostrar coordenadas cambiantes
    if (originPosition.current) {
      const randomLat = originPosition.current.latitude + (Math.random() - 0.5) * 0.01;
      const randomLng = originPosition.current.longitude + (Math.random() - 0.5) * 0.01;
      
      const simulatedPosition: Position = {
        latitude: randomLat,
        longitude: randomLng,
        timestamp: Date.now()
      };
      
      setCurrentPosition(simulatedPosition);
      
      // Actualizar dirección simulada si Google Maps está disponible
      if (googleMapsReady) {
        getLocationInfo(randomLat, randomLng)
          .then(address => setCurrentAddress(address))
          .catch(error => console.error('Error obteniendo dirección simulada:', error));
      }
    }
  };

  // Iniciar/detener modo de prueba
  const toggleTestMode = () => {
    if (!isTestMode) {
      // Iniciar modo de prueba
      console.log('🧪 Iniciando modo de prueba...');
      setIsTestMode(true);
      
      // Establecer una posición de origen simulada si no existe
      if (!originPosition.current) {
        originPosition.current = {
          latitude: 19.7069, // Coordenadas de ejemplo (Ciudad Guzmán)
          longitude: -103.4614
        };
        
        const initialPosition: Position = {
          latitude: 19.7069,
          longitude: -103.4614,
          timestamp: Date.now()
        };
        
        setCurrentPosition(initialPosition);
        setGpsStatus('available');
      }
      
      // Iniciar simulación si el viaje está activo
      if (tripData.isRunning && !tripData.isPaused) {
        testIntervalId.current = window.setInterval(simulateMovement, 1000); // Simular cada segundo
      }
    } else {
      // Detener modo de prueba
      console.log('🧪 Deteniendo modo de prueba...');
      setIsTestMode(false);
      
      if (testIntervalId.current) {
        clearInterval(testIntervalId.current);
        testIntervalId.current = null;
      }
    }
  };

  // Función legacy para mantener compatibilidad (no se usa más)
  const calculateTotalDistance = (origin: OriginPosition, current: Position): number => {
    return calculateDistanceFromOriginWithGoogleMaps(
      origin.latitude,
      origin.longitude,
      current.latitude,
      current.longitude
    );
  };

  // Función legacy para mantener compatibilidad (no se usa más)
  const calculateCost = (distance: number, waitingMinutes: number): number => {
    // Encontrar el rango de precio apropiado
    const range = RATES.ranges.find(r => distance >= r.min && distance <= r.max);
    const baseCost = range ? range.price : RATES.ranges[RATES.ranges.length - 1].price;
    const waitingCost = waitingMinutes * RATES.waitingRate;
    console.log(`Distancia: ${distance}km, Rango encontrado:`, range, `Costo base: ${baseCost}, Costo espera: ${waitingCost}`);
    return baseCost + waitingCost;
  };

  // Inicializar geolocalización
  useEffect(() => {
    // Inicializar Google Maps API
    const initMaps = async () => {
      try {
        await initializeGoogleMaps();
        setGoogleMapsReady(true);
        console.log('Google Maps API inicializada correctamente');
      } catch (error) {
        console.error('Error inicializando Google Maps API:', error);
        setGoogleMapsReady(false);
      }
    };

    initMaps();

    if ('geolocation' in navigator) {
      setGpsStatus('available');
    } else {
      setGpsStatus('unavailable');
    }
  }, []);

  // Manejar actualizaciones de posición
  const handlePositionUpdate = (position: GeolocationPosition) => {
    const newPosition: Position = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      timestamp: Date.now()
    };

    console.log('🔄 Nueva posición GPS:', {
      lat: newPosition.latitude.toFixed(6),
      lng: newPosition.longitude.toFixed(6),
      accuracy: position.coords.accuracy,
      timestamp: new Date(newPosition.timestamp).toLocaleTimeString()
    });
    
    setCurrentPosition(newPosition);

    // Obtener información de dirección si Google Maps está listo
    if (googleMapsReady) {
      getLocationInfo(newPosition.latitude, newPosition.longitude)
        .then(address => setCurrentAddress(address))
        .catch(error => console.error('Error obteniendo dirección:', error));
    }

    // Calcular distancia desde el origen fijo si el viaje está activo
    if (tripData.isRunning && !tripData.isPaused && originPosition.current) {
      const distanceFromOrigin = calculateDistanceFromOriginWithGoogleMaps(originPosition.current, newPosition);
      
      console.log('📏 Calculando distancia desde origen fijo:');
      console.log('  Origen:', {
        lat: originPosition.current.latitude.toFixed(6),
        lng: originPosition.current.longitude.toFixed(6)
      });
      console.log('  Actual:', {
        lat: newPosition.latitude.toFixed(6),
        lng: newPosition.longitude.toFixed(6)
      });
      console.log('  Distancia desde origen:', distanceFromOrigin.toFixed(3), 'km');
      
      // Solo actualizar si la precisión del GPS es razonable (menos de 20 metros de error)
      const maxAccuracy = 20; // 20 metros de precisión máxima
      
      if (position.coords.accuracy <= maxAccuracy) {
        console.log('✅ Posición GPS válida, actualizando distancia desde origen:');
        console.log('  Distancia desde origen:', distanceFromOrigin.toFixed(3), 'km');
        console.log('  Precisión GPS:', position.coords.accuracy.toFixed(1), 'm');
        
        setTripData(prev => {
          const newCost = calculateCostFromDistance(distanceFromOrigin, prev.waitingTime / 60);
          console.log('📊 Actualizando totales:');
          console.log('  Distancia desde origen:', distanceFromOrigin.toFixed(3), 'km');
          console.log('  Nuevo costo: $', newCost);
          
          return {
            ...prev,
            distance: distanceFromOrigin,
            cost: newCost
          };
        });
      } else {
        console.log('⚠️ Precisión GPS insuficiente:', position.coords.accuracy.toFixed(1), 'm (máx:', maxAccuracy, 'm)');
      }
    }
    
    // Actualizar la última posición para referencia
    lastPosition.current = newPosition;
  };

  // Iniciar el taxímetro
  const startTrip = () => {
    if (gpsStatus !== 'available') return;

    setGpsStatus('requesting');
    console.log('🚀 Iniciando viaje...');
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGpsStatus('available');
        console.log('📍 Posición inicial obtenida:', {
          lat: position.coords.latitude.toFixed(6),
          lng: position.coords.longitude.toFixed(6),
          accuracy: position.coords.accuracy
        });
        
        // Guardar la posición inicial como origen fijo
        originPosition.current = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };
        console.log('🎯 Origen fijo establecido:', originPosition.current);
        
        handlePositionUpdate(position);
        startTime.current = Date.now();
        
        setTripData(prev => ({
          ...prev,
          isRunning: true,
         isPaused: false,
         distance: 0, // Reiniciar distancia
         cost: getBasePrice(selectedTripType) // Usar precio base del tipo de viaje seleccionado
        }));

        // Iniciar seguimiento GPS o modo de prueba
        if (isTestMode) {
          console.log('🧪 Iniciando simulación de movimiento...');
          testIntervalId.current = window.setInterval(simulateMovement, 1000);
        } else {
          watchId.current = navigator.geolocation.watchPosition(
            handlePositionUpdate,
            (error) => {
              console.error('❌ Error GPS:', error.message);
              setGpsStatus('denied');
            },
            {
              enableHighAccuracy: true,
              timeout: 10000,
              maximumAge: 5000
            }
          );
          
          console.log('✅ Seguimiento GPS iniciado con watchId:', watchId.current);
        }
      },
      (error) => {
        console.error('❌ Error obteniendo posición inicial:', error.message);
        setGpsStatus('denied');
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  };

  // Pausar/reanudar el taxímetro
  const togglePause = () => {
    setTripData(prev => {
      if (!prev.isPaused) {
        // Pausar - iniciar conteo de tiempo de espera
        console.log('⏸️ Pausando viaje...');
        pauseStartTime.current = Date.now();
        
        // Iniciar contador de tiempo de espera
        intervalId.current = window.setInterval(() => {
          if (pauseStartTime.current) {
            const waitingSeconds = (Date.now() - pauseStartTime.current) / 1000;
            setTripData(current => ({
              ...current,
              waitingTime: current.waitingTime + 1,
              cost: calculateCost(current.distance, (current.waitingTime + 1) / 60)
            }));
          }
        }, 1000);
        
        // Pausar simulación si está en modo de prueba
        if (isTestMode && testIntervalId.current) {
          clearInterval(testIntervalId.current);
          testIntervalId.current = null;
        }
        
        return { ...prev, isPaused: true };
      } else {
        // Reanudar - detener conteo de tiempo de espera
        console.log('▶️ Reanudando viaje...');
        if (intervalId.current) {
          clearInterval(intervalId.current);
          intervalId.current = null;
        }
        pauseStartTime.current = null;
        
        // Reanudar simulación si está en modo de prueba
        if (isTestMode && tripData.isRunning) {
          testIntervalId.current = window.setInterval(simulateMovement, 1000);
        }
        
        return { ...prev, isPaused: false };
      }
    });
  };

  // Detener y reiniciar el taxímetro
  const stopTrip = () => {
    console.log('🛑 Finalizando viaje...');
    console.log('📊 Resumen final - Distancia:', tripData.distance.toFixed(3), 'km, Costo: $', tripData.cost);
    
    // Guardar resumen del viaje antes de reiniciar
    if (tripData.isRunning) {
      const summary: TripSummary = {
        distance: tripData.distance,
        waitingTime: tripData.waitingTime,
        cost: tripData.cost,
        tripType: selectedTripType.name,
        timestamp: new Date().toLocaleString('es-MX', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        })
      };
      setLastTripSummary(summary);
      setShowSummary(true);
    }

    if (watchId.current) {
      navigator.geolocation.clearWatch(watchId.current);
      console.log('🔄 Seguimiento GPS detenido');
      watchId.current = null;
    }
    
    if (intervalId.current) {
      clearInterval(intervalId.current);
      intervalId.current = null;
    }
    
    if (testIntervalId.current) {
      clearInterval(testIntervalId.current);
      testIntervalId.current = null;
    }

    // Reiniciar todas las variables
    setTripData({
      distance: 0,
      duration: 0,
      waitingTime: 0,
      cost: getBasePrice(TRIP_TYPES[0]), // Usar precio base del viaje normal
      isRunning: false,
      isPaused: false
    });

    // Restablecer el tipo de viaje a "normal" por defecto
    setSelectedTripType(TRIP_TYPES[0]); // TRIP_TYPES[0] es "normal"
    // Limpiar referencias
    setSelectedSubTrip(null);
    // Limpiar el origen fijo
    originPosition.current = null;
    totalDistanceAccumulated.current = 0;
    lastPosition.current = null;
    startTime.current = null;
    pauseStartTime.current = null;
  };

  // Limpiar intervalos al desmontar
  useEffect(() => {
    return () => {
      if (watchId.current) {
        navigator.geolocation.clearWatch(watchId.current);
      }
      if (intervalId.current) {
        clearInterval(intervalId.current);
      }
      if (testIntervalId.current) {
        clearInterval(testIntervalId.current);
      }
    };
  }, []);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusColor = () => {
    if (!tripData.isRunning) return 'bg-gray-400 shadow-gray-400/50';
    if (tripData.isPaused) return 'bg-yellow-400 shadow-yellow-400/50';
    return 'bg-green-400 shadow-green-400/50';
  };

  const getStatusText = () => {
    if (!tripData.isRunning) return 'Detenido';
    if (tripData.isPaused) return 'Pausado';
    return 'En marcha';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-800 p-4">
      <InstallPrompt />
      <div className="max-w-md mx-auto">
        {/* Modal de resumen del viaje */}
        {showSummary && lastTripSummary && (
          <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
            <div className="bg-gradient-to-br from-gray-900 to-black border border-yellow-400 rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <div className="flex items-center justify-center mb-4">
                <Zap className="w-8 h-8 text-yellow-400 mr-2" />
                <h2 className="text-2xl font-bold text-center text-white">
                  Resumen del Viaje
                </h2>
              </div>
              
              <div className="space-y-4">
                <div className="bg-gray-800 border border-gray-700 p-3 rounded-lg">
                  <div className="text-center">
                    <span className="text-yellow-400 font-bold text-lg">{lastTripSummary.tripType}</span>
                  </div>
                </div>
                
                <div className="bg-gray-800 border border-gray-700 p-4 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-gray-300">Distancia recorrida:</span>
                    <span className="font-bold text-lg text-yellow-400">{lastTripSummary.distance.toFixed(3)} km</span>
                  </div>
                  
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-gray-300">Tiempo de espera:</span>
                    <span className="font-bold text-lg text-yellow-400">{formatTime(lastTripSummary.waitingTime)}</span>
                  </div>
                  
                  <div className="border-t border-gray-600 pt-2 mt-2">
                    <div className="flex justify-between items-center">
                      <span className="text-white font-bold text-lg">Total a cobrar:</span>
                      <span className="font-bold text-2xl text-green-400">
                        ${lastTripSummary.cost.toFixed(0)} MXN
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="text-center text-sm text-gray-400">
                  Viaje finalizado: {lastTripSummary.timestamp}
                </div>
                
                <button
                  onClick={() => setShowSummary(false)}
                  className="w-full bg-gradient-to-r from-yellow-400 to-yellow-500 hover:from-yellow-500 hover:to-yellow-600 text-black font-bold py-3 px-4 rounded-lg transition-all transform hover:scale-105 shadow-lg"
                >
                  Cerrar Resumen
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal de selección de tipo de viaje */}
        {showTripTypeSelector && (
          <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
            <div className="bg-gradient-to-br from-gray-900 to-black border border-yellow-400 rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <div className="flex items-center justify-center mb-4">
                <Route className="w-8 h-8 text-yellow-400 mr-2" />
                <h2 className="text-2xl font-bold text-center text-white">
                  Tipo de Viaje
                </h2>
              </div>
              
              <div className="space-y-3">
                {TRIP_TYPES.map((tripType) => (
                  <button
                    key={tripType.id}
                    onClick={() => {
                      if (tripType.subTrips) {
                        setSelectedTripType(tripType);
                        setShowTripTypeSelector(false);
                        setShowSubTripSelector(true);
                      } else {
                        setSelectedTripType(tripType);
                        setSelectedSubTrip(null);
                        setShowTripTypeSelector(false);
                      }
                    }}
                    className={`w-full p-4 rounded-xl border-2 transition-all text-left ${
                      selectedTripType.id === tripType.id
                        ? 'border-yellow-400 bg-yellow-400/10 text-yellow-400'
                        : 'border-gray-600 bg-gray-800 text-white hover:border-yellow-400/50'
                    }`}
                  >
                    <div className="font-bold text-lg">{tripType.name}</div>
                    <div className="text-sm text-gray-300 mt-1">{tripType.description}</div>
                    {tripType.fixedPrice && (
                      <div className="text-green-400 font-bold mt-2">
                        Precio base: ${tripType.fixedPrice} MXN
                      </div>
                    )}
                    {tripType.subTrips && (
                      <div className="text-blue-400 font-bold mt-2">
                        Toca para elegir destino específico
                      </div>
                    )}
                  </button>
                ))}
              </div>
              
              <button
                onClick={() => setShowTripTypeSelector(false)}
                className="w-full mt-4 bg-gradient-to-r from-gray-700 to-gray-600 hover:from-gray-600 hover:to-gray-500 text-white font-bold py-3 px-4 rounded-lg transition-all"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Modal de selección de sub-viaje (Cristo Rey) */}
        {showSubTripSelector && selectedTripType.subTrips && (
          <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
            <div className="bg-gradient-to-br from-gray-900 to-black border border-yellow-400 rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <div className="flex items-center justify-center mb-4">
                <Route className="w-8 h-8 text-yellow-400 mr-2" />
                <h2 className="text-2xl font-bold text-center text-white">
                  {selectedTripType.name}
                </h2>
              </div>
              
              <div className="mb-4 text-center">
                <p className="text-gray-300 text-sm">{selectedTripType.description}</p>
              </div>
              
              <div className="space-y-3">
                {selectedTripType.subTrips.map((subTrip) => (
                  <button
                    key={subTrip.id}
                    onClick={() => {
                      setSelectedSubTrip(subTrip);
                      setShowSubTripSelector(false);
                    }}
                    className={`w-full p-4 rounded-xl border-2 transition-all text-left ${
                      selectedSubTrip?.id === subTrip.id
                        ? 'border-yellow-400 bg-yellow-400/10 text-yellow-400'
                        : 'border-gray-600 bg-gray-800 text-white hover:border-yellow-400/50'
                    }`}
                  >
                    <div className="font-bold text-lg">{subTrip.name}</div>
                    <div className="text-green-400 font-bold mt-2">
                      Precio: ${subTrip.fixedPrice} MXN
                    </div>
                  </button>
                ))}
              </div>
              
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => {
                    setShowSubTripSelector(false);
                    setShowTripTypeSelector(true);
                  }}
                  className="flex-1 bg-gradient-to-r from-gray-700 to-gray-600 hover:from-gray-600 hover:to-gray-500 text-white font-bold py-3 px-4 rounded-lg transition-all"
                >
                  Atrás
                </button>
                <button
                  onClick={() => {
                    setShowSubTripSelector(false);
                    setSelectedSubTrip(null);
                  }}
                  className="flex-1 bg-gradient-to-r from-gray-700 to-gray-600 hover:from-gray-600 hover:to-gray-500 text-white font-bold py-3 px-4 rounded-lg transition-all"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Header */}
        <div className="bg-gradient-to-r from-black via-gray-900 to-black border-b-2 border-yellow-400 rounded-t-xl p-6 text-center shadow-2xl">
          <div className="flex items-center justify-center mb-2">
            <Zap className="w-10 h-10 text-yellow-400 mr-3 animate-pulse" />
            <div>
              <h1 className="text-3xl font-bold text-white tracking-wider">SPEED CABS</h1>
              <p className="text-yellow-400 text-sm font-semibold tracking-widest">ZAPOTLAN</p>
            </div>
            <Zap className="w-10 h-10 text-yellow-400 ml-3 animate-pulse" />
          </div>
          <div className="flex items-center justify-center mt-2">
            <div className={`w-4 h-4 rounded-full ${getStatusColor()} mr-2 animate-pulse shadow-lg`}></div>
            <span className="text-sm text-gray-300 font-medium">{getStatusText()}</span>
            {selectedTripType.id !== 'normal' && (
              <span className="ml-2 text-xs bg-yellow-400 text-black px-2 py-1 rounded-full font-bold">
                {selectedTripType.name}
              </span>
            )}
          </div>
        </div>

        {/* Pantalla principal */}
        <div className="bg-gradient-to-b from-gray-900 to-black text-yellow-400 p-6 text-center border-x-2 border-yellow-400">
          <div className="text-6xl font-mono font-bold mb-6 bg-gradient-to-br from-black to-gray-900 p-6 rounded-xl border-2 border-yellow-400 shadow-2xl relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-400/5 to-transparent animate-pulse"></div>
            ${tripData.cost.toFixed(0)} MXN
          </div>
          
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-4 rounded-xl border border-gray-700 shadow-lg hover:border-yellow-400/50 transition-all">
              <div className="flex items-center justify-center mb-1">
                <Route className="w-5 h-5 mr-1 text-yellow-400" />
              </div>
              <div className="text-xs text-gray-400 font-semibold">DISTANCIA</div>
              <div className="font-mono font-bold text-white">{tripData.distance.toFixed(3)} km</div>
            </div>
            
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-4 rounded-xl border border-gray-700 shadow-lg hover:border-yellow-400/50 transition-all">
              <div className="flex items-center justify-center mb-1">
                <Clock className="w-5 h-5 mr-1 text-yellow-400" />
              </div>
              <div className="text-xs text-gray-400 font-semibold">ESPERA</div>
              <div className="font-mono font-bold text-white">{formatTime(tripData.waitingTime)}</div>
            </div>
            
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-4 rounded-xl border border-gray-700 shadow-lg hover:border-yellow-400/50 transition-all">
              <div className="flex items-center justify-center mb-1">
                <Navigation className="w-5 h-5 mr-1 text-yellow-400" />
              </div>
              <div className="text-xs text-gray-400 font-semibold">GPS</div>
              <div className="font-bold text-xs text-white">
                {gpsStatus === 'available' && currentPosition ? (googleMapsReady ? 'Maps+GPS' : 'GPS Básico') : 
                 gpsStatus === 'requesting' ? 'Buscando...' :
                 gpsStatus === 'denied' ? 'Sin acceso' : 'No disponible'}
              </div>
            </div>
          </div>

          {/* Información de ubicación actual */}
          {currentPosition && currentAddress && (
            <div className="mt-4 bg-gradient-to-br from-gray-800 to-gray-900 p-3 rounded-xl border border-gray-700 shadow-lg">
              <div className="flex items-center justify-center mb-2">
                <MapPin className="w-4 h-4 text-yellow-400 mr-2" />
                <span className="text-xs text-gray-400 font-semibold">UBICACIÓN ACTUAL</span>
              </div>
              <div className="text-xs text-white text-center break-words">
                {currentAddress}
              </div>
            </div>
          )}
        </div>

        {/* Controles */}
        <div className="bg-gradient-to-b from-black to-gray-900 p-6 rounded-b-xl border-2 border-t-0 border-yellow-400 shadow-2xl">
          {/* Selector de tipo de viaje */}
          {!tripData.isRunning && (
            <div className="mb-4">
              <button
                onClick={() => setShowTripTypeSelector(true)}
                className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white p-4 rounded-xl flex items-center justify-center font-bold transition-all border border-blue-500 shadow-lg"
              >
                <Route className="w-5 h-5 mr-2" />
                {selectedTripType.name}
                {selectedSubTrip && ` - ${selectedSubTrip.name}`}
                <ChevronDown className="w-5 h-5 ml-2" />
              </button>
              
              {selectedTripType.id !== 'normal' && (
                <div className="mt-2 bg-gradient-to-r from-blue-800 to-blue-900 text-white p-3 rounded-xl text-center border border-blue-500 shadow-lg">
                  <p className="text-sm">
                    📍 {selectedTripType.description}
                    {selectedSubTrip && ` → ${selectedSubTrip.name}`}
                  </p>
                  {(selectedTripType.fixedPrice || selectedSubTrip) && (
                    <p className="text-green-400 font-bold mt-1">
                      Precio base: ${selectedSubTrip ? selectedSubTrip.fixedPrice : selectedTripType.fixedPrice} MXN + tiempo de espera
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          
          <div className="flex justify-center space-x-4">
            {!tripData.isRunning ? (
              <button
                onClick={startTrip}
                disabled={gpsStatus !== 'available'}
                className="bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed text-white px-8 py-4 rounded-xl flex items-center font-bold text-lg transition-all transform hover:scale-105 shadow-lg border border-green-400"
              >
                <Play className="w-6 h-6 mr-2 drop-shadow-lg" />
                INICIAR
              </button>
            ) : (
              <>
                <button
                  onClick={togglePause}
                  className="bg-gradient-to-r from-yellow-500 to-yellow-600 hover:from-yellow-600 hover:to-yellow-700 text-black px-6 py-4 rounded-xl flex items-center font-bold transition-all transform hover:scale-105 shadow-lg border border-yellow-400"
                >
                  {tripData.isPaused ? (
                    <>
                      <Play className="w-5 h-5 mr-2 drop-shadow-lg" />
                      REANUDAR
                    </>
                  ) : (
                    <>
                      <Pause className="w-5 h-5 mr-2 drop-shadow-lg" />
                      PAUSAR
                    </>
                  )}
                </button>
                
                <button
                  onClick={stopTrip}
                  className="bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white px-6 py-4 rounded-xl flex items-center font-bold transition-all transform hover:scale-105 shadow-lg border border-red-400"
                >
                  <Square className="w-5 h-5 mr-2 drop-shadow-lg" />
                  FINALIZAR
                </button>
              </>
            )}
          </div>

          {/* Botón de modo de prueba */}
          <div className="mt-4">
            <button
              onClick={toggleTestMode}
              className={`w-full p-4 rounded-xl flex items-center justify-center font-bold transition-all border shadow-lg ${
                isTestMode 
                  ? 'bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white border-purple-400' 
                  : 'bg-gradient-to-r from-gray-800 to-gray-700 hover:from-gray-700 hover:to-gray-600 text-purple-400 border-gray-600 hover:border-purple-400/50'
              }`}
            >
              <TestTube className="w-5 h-5 mr-2" />
              {isTestMode ? 'DESACTIVAR MODO PRUEBA' : 'ACTIVAR MODO PRUEBA'}
            </button>
            
            {isTestMode && (
              <div className="mt-2 bg-gradient-to-r from-purple-800 to-purple-900 text-white p-3 rounded-xl text-center border border-purple-500 shadow-lg">
                <p className="text-xs">
                  🧪 Modo de prueba activo - Simulando movimiento automáticamente
                </p>
              </div>
            )}
          </div>

          {/* Información de tarifas */}
          <div className="mt-6">
            <button
              onClick={() => setShowRates(!showRates)}
              className="w-full bg-gradient-to-r from-gray-800 to-gray-700 hover:from-gray-700 hover:to-gray-600 text-yellow-400 p-4 rounded-xl flex items-center justify-center font-bold transition-all border border-gray-600 hover:border-yellow-400/50 shadow-lg"
            >
              <Info className="w-5 h-5 mr-2" />
              VER TARIFAS
              {showRates ? (
                <ChevronUp className="w-5 h-5 ml-2" />
              ) : (
                <ChevronDown className="w-5 h-5 ml-2" />
              )}
            </button>
            
            {showRates && (
              <div className="mt-3 bg-gradient-to-br from-gray-800 to-gray-900 p-4 rounded-xl border border-gray-600 shadow-lg">
                <div className="flex items-center justify-center mb-3">
                  <Zap className="w-5 h-5 text-yellow-400 mr-2" />
                  <h3 className="text-yellow-400 font-bold text-center">TARIFAS SPEED CABS</h3>
                </div>
                <div className="text-white text-sm space-y-1">
                  <div className="flex justify-between">
                    <span>Tarifa base:</span>
                    <span className="text-yellow-400 font-semibold">${RATES.baseFare} MXN</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tiempo espera:</span>
                    <span className="text-yellow-400 font-semibold">${RATES.waitingRate} MXN/min</span>
                  </div>
                  <div className="text-xs text-gray-300 mt-3 bg-gray-800 p-2 rounded-lg">
                    <div className="flex justify-between"><span>0-4.9 km:</span><span className="text-yellow-400">$50 MXN</span></div>
                    <div className="flex justify-between"><span>5-5.9 km:</span><span className="text-yellow-400">$60 MXN</span></div>
                    <div className="flex justify-between"><span>6-6.9 km:</span><span className="text-yellow-400">$65 MXN</span></div>
                    <div className="flex justify-between"><span>7-7.9 km:</span><span className="text-yellow-400">$70 MXN</span></div>
                    <div className="flex justify-between"><span>8+ km:</span><span className="text-yellow-400">$80 MXN</span></div>
                    <div className="flex justify-between"><span>8+ km:</span><span className="text-yellow-400">$16/km extra</span></div>
                    <div className="text-center mt-2 pt-2 border-t border-gray-600">
                      <span className="text-yellow-400 text-xs">
                        {googleMapsReady ? '✓ Google Maps Activo' : '⚠ GPS Básico'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {gpsStatus === 'denied' && (
            <div className="mt-4 bg-gradient-to-r from-red-600 to-red-700 text-white p-4 rounded-xl text-center border border-red-500 shadow-lg">
              <p className="text-sm">Se necesita acceso a la ubicación para funcionar correctamente.</p>
            </div>
          )}

          {gpsStatus === 'unavailable' && (
            <div className="mt-4 bg-gradient-to-r from-orange-600 to-orange-700 text-white p-4 rounded-xl text-center border border-orange-500 shadow-lg">
              <p className="text-sm">GPS no disponible en este dispositivo.</p>
            </div>
          )}

          {!googleMapsReady && gpsStatus === 'available' && (
            <div className="mt-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4 rounded-xl text-center border border-blue-500 shadow-lg">
              <p className="text-sm">Usando GPS básico. Google Maps no disponible.</p>
            </div>
          )}
          
          {/* Panel de debug para desarrollo */}
          {tripData.isRunning && currentPosition && (
            <div className="mt-4 bg-gradient-to-r from-purple-800 to-purple-900 text-white p-3 rounded-xl text-center border border-purple-500 shadow-lg">
              <div className="text-xs">
                <div>Estado: {tripData.isPaused ? 'Pausado' : 'Activo'} {isTestMode ? '(PRUEBA)' : '(GPS)'}</div>
                <div>Método: {isTestMode ? 'Simulación de Prueba' : 'Distancia desde Origen Fijo'}</div>
                <div>Distancia desde origen: {tripData.distance.toFixed(3)} km</div>
                {originPosition.current && (
                  <div>Origen: {originPosition.current.latitude.toFixed(6)}, {originPosition.current.longitude.toFixed(6)}</div>
                )}
                <div>Posición: {currentPosition.latitude.toFixed(6)}, {currentPosition.longitude.toFixed(6)}</div>
                <div>Última actualización: {new Date(currentPosition.timestamp).toLocaleTimeString()}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { App };
export default App;